import { Effect, Fiber, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  ctx,
  fakeChildren,
  fakeGithub,
  fakeIntents,
  OTHER_SHA,
  SHA,
  type ChildScript,
} from "./gate.test-support.ts";
import type { OffloadTestInput } from "./inputs.ts";
import type { MatrixEntry, MatrixJob } from "./manifest.ts";
import {
  aggregate,
  childDedupKey,
  expandMatrix,
  jobCheckConclusions,
  releaseRefOf,
  unionJobs,
  type JobState,
} from "./matrix.ts";
import { runOffloadTest, warmRequest } from "./offload-test.ts";
import { Outcome } from "./reasons.ts";

const ok: ChildScript = () => ({ verdict: { _tag: "Recorded", outcome: Outcome.success() } });
const failing =
  (
    keys: readonly string[],
    reason: Parameters<typeof Outcome.failure>[0] = "exit: 1",
  ): ChildScript =>
  (r) => ({
    verdict: {
      _tag: "Recorded",
      outcome: keys.includes(r.key) ? Outcome.failure(reason) : Outcome.success(),
    },
  });

const input = (entry: MatrixEntry, over: Partial<OffloadTestInput> = {}): OffloadTestInput => ({
  ...ctx,
  scope: "o/r",
  entry,
  parentDedupKey: `offload-test:o/r:${SHA}`,
  trigger: "pull_request",
  ...over,
});

const runWith = (script: ChildScript, entry: MatrixEntry, over: Partial<OffloadTestInput> = {}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const children = yield* fakeChildren(script);
      const intents = fakeIntents();
      const github = fakeGithub({});
      const outcome = yield* runOffloadTest(input(entry, over)).pipe(
        Effect.provide(Layer.mergeAll(children.layer, intents.layer, github.layer)),
      );
      return { outcome, children, intents, github };
    }),
  );

const jobs = (...list: MatrixJob[]) => ({ jobs: list });

describe("offload-test", () => {
  it("[FD-GATE-025] runs a single command as the job test", async () => {
    const { outcome, children } = await runWith(ok, { command: "pnpm test" });
    expect(outcome).toEqual({ _tag: "success" });
    expect(children.started.map((s) => s.key)).toEqual(["test"]);
  });

  it("[FD-GATE-026] refuses an entry with no command and starts no job", async () => {
    const { outcome, children } = await runWith(ok, {});
    expect(outcome).toEqual({ _tag: "failure", reason: "config: no command" });
    expect(children.started).toEqual([]);
  });

  it("[FD-GATE-027] gives every job the entry's install command", async () => {
    const { children } = await runWith(ok, {
      install: "pnpm i",
      ...jobs({ key: "a", command: "x" }),
    });
    expect(children.started[0]!.input).toMatchObject({ install: "pnpm i", command: "x" });
  });

  it("[FD-GATE-017] skips a draft pull request without starting a job", async () => {
    const { outcome, children } = await runWith(
      ok,
      { command: "t" },
      {
        pullRequest: { draft: true, author: "a" },
      },
    );
    expect(outcome).toEqual({ _tag: "skipped", detail: "draft-pr" });
    expect(children.started).toEqual([]);
  });
});

describe("job matrix expansion", () => {
  it("[FD-GATE-029] refuses 0 jobs and more than 64", () => {
    expect(expandMatrix([], "other")).toEqual({ failure: Outcome.failure("config: matrix size") });
    expect(
      expandMatrix(
        [
          { key: "a", command: "x", shards: 40 },
          { key: "b", command: "x", shards: 25 },
        ],
        "other",
      ),
    ).toEqual({
      failure: Outcome.failure("config: matrix size"),
    });
  });

  it("[FD-GATE-032] refuses a bad or duplicate job key", () => {
    for (const list of [
      [{ key: "-x", command: "c" }],
      [
        { key: "a", command: "c" },
        { key: "a", command: "d" },
      ],
    ])
      expect(expandMatrix(list, "other")).toEqual({ failure: Outcome.failure("config: job key") });
  });

  it("[FD-GATE-034] expands shards into <key>-<i> with FD_SHARD_INDEX and FD_SHARD_TOTAL", () => {
    const result = expandMatrix([{ key: "e2e", command: "c", shards: 3 }], "other");
    if (!("jobs" in result)) throw new Error("expected jobs");
    expect(result.jobs.map((j) => [j.key, j.env])).toEqual([
      ["e2e-1", { FD_SHARD_INDEX: "1", FD_SHARD_TOTAL: "3" }],
      ["e2e-2", { FD_SHARD_INDEX: "2", FD_SHARD_TOTAL: "3" }],
      ["e2e-3", { FD_SHARD_INDEX: "3", FD_SHARD_TOTAL: "3" }],
    ]);
    expect(expandMatrix([{ key: "e2e", command: "c", shards: 0 }], "other")).toEqual({
      failure: Outcome.failure("config: shards"),
    });
  });

  it("[FD-GATE-037] refuses a needs cycle or an unknown needs key", () => {
    expect(
      expandMatrix(
        [
          { key: "a", command: "c", needs: ["b"] },
          { key: "b", command: "c", needs: ["a"] },
        ],
        "other",
      ),
    ).toEqual({ failure: Outcome.failure("config: needs") });
    expect(expandMatrix([{ key: "a", command: "c", needs: ["zz"] }], "other")).toEqual({
      failure: Outcome.failure("config: needs"),
    });
  });

  it("[FD-GATE-052] keeps heavy jobs off pull_request and merge_group triggers", () => {
    const list: MatrixJob[] = [
      { key: "unit", command: "c" },
      { key: "soak", command: "c", heavy: true },
      { key: "after-soak", command: "c", needs: ["soak"] },
    ];
    for (const trigger of ["pull_request", "merge_group"] as const) {
      const r = expandMatrix(list, trigger);
      expect("jobs" in r && r.jobs.map((j) => j.key)).toEqual(["unit"]);
    }
    const push = expandMatrix(list, "push-default");
    expect("jobs" in push && push.jobs.map((j) => j.key)).toEqual(["unit", "soak", "after-soak"]);
  });

  it("[FD-GATE-031] derives each job's dedup key from the parent's", () => {
    expect(childDedupKey("offload-test:o/r:abc", "e2e-2")).toBe("offload-test:o/r:abc/e2e-2");
  });
});

describe("job matrix run", () => {
  it("[FD-GATE-030] and [FD-GATE-031] start each job as its own child with a derived dedup key", async () => {
    const { children } = await runWith(
      ok,
      jobs({ key: "a", command: "x" }, { key: "b", command: "y" }),
    );
    expect(children.started.map((s) => [s.run, s.dedupKey])).toEqual([
      ["gate-job", `offload-test:o/r:${SHA}/a`],
      ["gate-job", `offload-test:o/r:${SHA}/b`],
    ]);
  });

  it("[FD-GATE-033] starts no more than window jobs at once, 10 by default", async () => {
    const slow: ChildScript = () => ({
      verdict: { _tag: "Recorded", outcome: Outcome.success() },
      afterMs: 5,
    });
    const many = { jobs: [{ key: "s", command: "x", shards: 30 }] };
    expect((await runWith(slow, { ...many, window: 3 })).children.peak()).toBe(3);
    expect((await runWith(slow, many)).children.peak()).toBe(10);
    expect((await runWith(slow, { ...many, window: 65 })).outcome).toEqual(
      Outcome.failure("config: window"),
    );
  });

  it("[FD-GATE-035] and [FD-GATE-036] start a job only after its needs succeed, else record it not started", async () => {
    const entry = jobs(
      { key: "typecheck", command: "x" },
      { key: "e2e", command: "y", shards: 2, needs: ["typecheck"] },
    );
    const passed = await runWith(ok, entry);
    expect(passed.children.started.map((s) => s.key)).toEqual(["typecheck", "e2e-1", "e2e-2"]);
    const failed = await runWith(failing(["typecheck"]), entry);
    expect(failed.children.started.map((s) => s.key)).toEqual(["typecheck"]);
    expect(failed.outcome).toEqual(Outcome.failure("jobs: typecheck, e2e-1, e2e-2"));
  });

  it("[FD-GATE-038] succeeds only if every job succeeded or skipped and one succeeded", () => {
    const states = new Map<string, JobState>([
      ["a", { _tag: "Done", outcome: Outcome.success() }],
      ["b", { _tag: "Done", outcome: Outcome.skipped("nothing-to-lint") }],
    ]);
    expect(aggregate(["a", "b"], states)).toEqual(Outcome.success());
  });

  it("[FD-GATE-039] skips when every job skipped", () => {
    const states = new Map<string, JobState>([
      ["a", { _tag: "Done", outcome: Outcome.skipped("nothing-to-lint") }],
    ]);
    expect(aggregate(["a"], states)).toEqual(Outcome.skipped("every-job-skipped"));
  });

  it("[FD-GATE-040] lists the first 25 failed or not-started keys in expansion order", () => {
    const order = Array.from({ length: 30 }, (_, i) => `k${i}`);
    const states = new Map<string, JobState>(
      order.map((k) => [k, { _tag: "Done", outcome: Outcome.failure("exit: 1") }]),
    );
    expect(aggregate(order, states)).toEqual(
      Outcome.failure(`jobs: ${order.slice(0, 25).join(", ")}`),
    );
  });

  it("[FD-GATE-041] counts a job with no verdict as infra: no verdict", async () => {
    const none: ChildScript = () => ({ verdict: { _tag: "NoVerdict" } });
    const { outcome } = await runWith(none, jobs({ key: "a", command: "x" }));
    expect(outcome).toEqual(Outcome.failure("jobs: a"));
  });

  it("[FD-GATE-004] has no field that maps a failed job or shard to success", async () => {
    const entry = {
      jobs: [{ key: "e2e", command: "x", shards: 4 }],
      failFast: false,
      checkPerJob: true,
    };
    const { outcome } = await runWith(failing(["e2e-3"]), entry);
    expect(outcome).toEqual(Outcome.failure("jobs: e2e-3"));
  });

  it("[FD-GATE-042] cancels every placed or running job when the parent is cancelled", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const hang: ChildScript = () => ({
          verdict: { _tag: "Recorded", outcome: Outcome.success() },
          afterMs: 60_000,
        });
        const children = yield* fakeChildren(hang);
        const fiber = yield* runOffloadTest(
          input({ jobs: [{ key: "s", command: "x", shards: 5 }], window: 2 }),
        ).pipe(
          Effect.provide(Layer.mergeAll(children.layer, fakeIntents().layer, fakeGithub({}).layer)),
          Effect.forkChild,
        );
        yield* Effect.sleep(20);
        yield* Fiber.interrupt(fiber);
        return children;
      }),
    );
    expect(result.started.map((s) => s.key)).toEqual(["s-1", "s-2"]);
    expect(result.cancelled.sort()).toEqual(["s-1", "s-2"]);
  });

  it("[FD-GATE-043] starts no further job after a failure under failFast", async () => {
    const entry = { jobs: [{ key: "s", command: "x", shards: 6 }], window: 1, failFast: true };
    const { children, outcome } = await runWith(failing(["s-2"]), entry);
    expect(children.started.map((s) => s.key)).toEqual(["s-1", "s-2"]);
    expect(outcome).toEqual(Outcome.failure("jobs: s-2, s-3, s-4, s-5, s-6"));
  });

  it("[FD-GATE-044] starts no further job after a budget, capacity or halt failure", async () => {
    for (const reason of [
      "budget: required reserve exhausted",
      "capacity: queue full",
      "halt: operator halted",
    ] as const) {
      const entry = { jobs: [{ key: "s", command: "x", shards: 4 }], window: 1 };
      const { children } = await runWith(failing(["s-1"], reason), entry);
      expect(children.started.map((s) => s.key)).toEqual(["s-1"]);
    }
  });

  it("[FD-GATE-045] runs the parent with no GateExec in its context", async () => {
    // `runWith` provides only MatrixChildren, GateIntents and GithubRead; a sandbox call would fail to resolve.
    const { outcome } = await runWith(ok, { command: "x" });
    expect(outcome).toEqual(Outcome.success());
  });

  it("[FD-GATE-046] names each job check flare-dispatch/<run>:<job key> under checkPerJob", async () => {
    const { children } = await runWith(ok, {
      ...jobs({ key: "a", command: "x" }),
      checkPerJob: true,
    });
    expect(children.started[0]!.checkName).toBe("flare-dispatch/offload-test:a");
    const without = await runWith(ok, jobs({ key: "a", command: "x" }));
    expect(without.children.started[0]!.checkName).toBeUndefined();
  });

  it("[FD-GATE-047] concludes each open job check with its outcome, or failure when it has none", () => {
    const states = new Map<string, JobState>([
      ["a", { _tag: "Done", outcome: Outcome.success() }],
      ["b", { _tag: "NotStarted", reason: "needs: a" }],
    ]);
    const conclusions = jobCheckConclusions(
      "offload-test",
      ["a", "b", "c"],
      states,
      new Set(["flare-dispatch/offload-test:a"]),
    );
    expect(conclusions).toEqual([
      {
        checkName: "flare-dispatch/offload-test:b",
        outcome: Outcome.failure("infra: no verdict"),
        summary: "parent closed before this part settled",
      },
      {
        checkName: "flare-dispatch/offload-test:c",
        outcome: Outcome.failure("infra: no verdict"),
        summary: "parent closed before this part settled",
      },
    ]);
  });

  it("[FD-GATE-052] runs a heavy job at class interactive on a default-branch push", async () => {
    const { children } = await runWith(
      ok,
      jobs({ key: "unit", command: "x" }, { key: "soak", command: "y", heavy: true }),
      { trigger: "push-default" },
    );
    expect(children.started.map((s) => [s.key, s.className])).toEqual([
      ["unit", undefined],
      ["soak", "interactive"],
    ]);
  });

  it("[FD-GATE-053] runs a warm job at batch in the protected tier, with no check, superseded by the next head", () => {
    expect(
      warmRequest(
        { key: "warm", command: "pnpm build" },
        { repo: "o/r", sha: SHA, executorKind: "cloud" },
      ),
    ).toMatchObject({
      className: "batch",
      cacheTier: "protected-cloud",
      postsCheck: false,
      supersede: true,
    });
    expect(
      warmRequest({ key: "warm", command: "x" }, { repo: "o/r", sha: SHA, executorKind: "device" })
        .cacheTier,
    ).toBe("protected-device");
  });
});

describe("discovered matrices", () => {
  const discoverRun = (discovery: Parameters<typeof fakeChildren>[1]) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const children = yield* fakeChildren(ok, discovery);
        const outcome = yield* runOffloadTest(
          input({ discover: "node list-jobs.js" }, { baseSha: OTHER_SHA }),
        ).pipe(
          Effect.provide(Layer.mergeAll(children.layer, fakeIntents().layer, fakeGithub({}).layer)),
        );
        return { outcome, children };
      }),
    );

  it("[FD-GATE-048] runs discovery on the head and the base commit with a 600 s job timeout", async () => {
    const { children } = await discoverRun(() => ({
      _tag: "Exited",
      code: 0,
      output: '[{"key":"a","command":"x"}]',
    }));
    expect(
      children.discovered.map((d) => [
        d.key,
        (d.input as { sha: string }).sha,
        (d.input as { timeoutSec: number }).timeoutSec,
      ]),
    ).toEqual([
      ["discover-head", SHA, 600],
      ["discover-base", OTHER_SHA, 600],
    ]);
  });

  it("[FD-GATE-049] takes the union of the head's and the base's jobs", async () => {
    const { children } = await discoverRun((r) => ({
      _tag: "Exited",
      code: 0,
      output:
        r.key === "discover-head"
          ? '[{"key":"a","command":"x"}]'
          : '[{"key":"a","command":"old"},{"key":"b","command":"y"}]',
    }));
    expect(children.started.map((s) => s.key)).toEqual(["a", "b"]);
    expect(unionJobs([{ key: "a", command: "x" }], [{ key: "a", command: "y" }])).toEqual([
      { key: "a", command: "x" },
    ]);
  });

  it("[FD-GATE-050] records discover: exit <code> and starts no job", async () => {
    const { outcome, children } = await discoverRun((r) =>
      r.key === "discover-base"
        ? { _tag: "Exited", code: 2, output: "" }
        : { _tag: "Exited", code: 0, output: "[]" },
    );
    expect(outcome).toEqual(Outcome.failure("discover: exit 2"));
    expect(children.started).toEqual([]);
  });

  it("[FD-GATE-051] refuses an oversized, malformed or too-long discovery output", async () => {
    const outputs = [
      "x".repeat(4097),
      "{}",
      '[{"key":1}]',
      JSON.stringify(Array.from({ length: 65 }, (_, i) => ({ key: `k${i}`, command: "c" }))),
    ];
    for (const output of outputs) {
      const { outcome, children } = await discoverRun(() => ({ _tag: "Exited", code: 0, output }));
      expect(outcome).toEqual(Outcome.failure("config: discovery output"));
      expect(children.started).toEqual([]);
    }
  });
});

describe("release matrices", () => {
  const release = (over: {
    tag?: string;
    reachable?: boolean;
    ref?: string;
    script?: ChildScript;
    retries?: number;
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const children = yield* fakeChildren(over.script ?? ok);
        const intents = fakeIntents();
        const github = fakeGithub({
          ...(over.tag === undefined ? {} : { tag: over.tag }),
          ...(over.reachable === undefined ? {} : { reachable: over.reachable }),
        });
        const outcome = yield* runOffloadTest(
          input(
            {
              release: true,
              jobs: [
                {
                  key: "build",
                  command: "x",
                  ...(over.retries === undefined ? {} : { retries: over.retries }),
                },
              ],
            },
            { ref: over.ref ?? "refs/tags/v1.2.3", trigger: "other", defaultBranch: "main" },
          ),
        ).pipe(Effect.provide(Layer.mergeAll(children.layer, intents.layer, github.layer)));
        return { outcome, children, intents, github };
      }),
    );

  it("[FD-GATE-054] verifies the tag's commit is on the default branch before any job", async () => {
    const { github, outcome } = await release({});
    expect(github.reads[0]).toBe(`reachable ${SHA} main`);
    expect(outcome).toEqual(Outcome.success());
  });

  it("[FD-GATE-055] refuses a tag not on the default branch and starts no job", async () => {
    const { outcome, children, intents } = await release({ reachable: false });
    expect(outcome).toEqual(Outcome.failure("release: tag not on default branch"));
    expect(children.started).toEqual([]);
    expect(intents.emitted).toEqual([]);
  });

  it("[FD-GATE-056] and [FD-GATE-057] emit release.draft before the first job and release.publish after every success", async () => {
    const { intents } = await release({});
    expect(intents.emitted.map((i) => i.kind)).toEqual(["release.draft", "release.publish"]);
    const failed = await release({ script: failing(["build"]) });
    expect(failed.intents.emitted.map((i) => i.kind)).toEqual(["release.draft"]);
  });

  it("[FD-GATE-058] records release: tag moved when the tag points elsewhere before publish", async () => {
    const { outcome, intents } = await release({ tag: OTHER_SHA });
    expect(outcome).toEqual(Outcome.failure("release: tag moved"));
    expect(intents.emitted.map((i) => i.kind)).toEqual(["release.draft"]);
  });

  it("[FD-GATE-059] runs every job of a dry-run tag and emits no release intent", async () => {
    const { outcome, intents, children } = await release({ ref: "refs/tags/dry-run/v1.2.3" });
    expect(outcome).toEqual(Outcome.success());
    expect(children.started.map((s) => s.key)).toEqual(["build"]);
    expect(intents.emitted).toEqual([]);
    expect(releaseRefOf("refs/tags/v1.2")).toEqual({ _tag: "NotRelease" });
  });

  it("[FD-GATE-060] restarts a release job after an infrastructure error up to retries, never after an exit", async () => {
    const infra: ChildScript = (_r, attempt) => ({
      verdict: {
        _tag: "Recorded",
        outcome: attempt < 2 ? Outcome.failure("infra: SandboxProcessLost") : Outcome.success(),
      },
    });
    const recovered = await release({ script: infra });
    expect(recovered.outcome).toEqual(Outcome.success());
    expect(recovered.children.started.map((s) => s.dedupKey)).toEqual([
      `offload-test:o/r:${SHA}/build`,
      `offload-test:o/r:${SHA}/build:attempt-2`,
      `offload-test:o/r:${SHA}/build:attempt-3`,
    ]);
    const capped = await release({ script: infra, retries: 1 });
    expect(capped.outcome).toEqual(Outcome.failure("jobs: build"));
    const exit = await release({ script: failing(["build"]) });
    expect(exit.children.started).toHaveLength(1);
  });
});
