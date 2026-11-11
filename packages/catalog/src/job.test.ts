import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { runCheck } from "./check.ts";
import { CommandExit } from "./command.ts";
import { ctx, fakeArtifacts, fakeExec, SHA } from "./gate.test-support.ts";
import type { GateJobInput } from "./inputs.ts";
import { runGateJob, writebackBranch } from "./job.ts";
import { runOxlint, OXLINT_PINNED_VERSION } from "./oxlint.ts";
import { GateCache, localContentArtifacts, type CacheEntry } from "./ports.ts";
import { LocalContent, StoreUnavailable } from "@fractalboxdev/mameko-run";

const run = <A>(effect: Effect.Effect<A, never, never>): Promise<A> => Effect.runPromise(effect);

describe("artifacts on the device's local content store", () => {
  const stored: Uint8Array[] = [];
  const store = (answer: "store" | "refuse") =>
    Layer.succeed(LocalContent, {
      put: (bytes) =>
        answer === "refuse"
          ? Effect.fail(new StoreUnavailable({ reason: "content socket closed" }))
          : Effect.sync(() => (stored.push(bytes), `sha256:${"0".repeat(64)}`)),
      get: () => Effect.never,
    });

  it("[FD-GATE-012] uploads a step log of any size through the content store", async () => {
    stored.length = 0;
    const big = "x".repeat(110 * 1024);
    const exec = fakeExec([{ match: "pnpm test", output: big }]);
    const layer = Layer.mergeAll(
      exec.layer,
      localContentArtifacts.pipe(Layer.provide(store("store"))),
    );
    expect(await run(runGateJob(job()).pipe(Effect.provide(layer)))).toEqual({ _tag: "success" });
    expect(stored.some((bytes) => bytes.length >= big.length)).toBe(true);
  });

  it("[FD-GATE-012] returns the verdict when the store refuses a put", async () => {
    const exec = fakeExec([{ match: "pnpm test", exit: CommandExit.Exited({ code: 3 }) }]);
    const layer = Layer.mergeAll(
      exec.layer,
      localContentArtifacts.pipe(Layer.provide(store("refuse"))),
    );
    expect(await run(runGateJob(job()).pipe(Effect.provide(layer)))).toEqual({
      _tag: "failure",
      reason: "exit: 3",
    });
  });
});

const job = (over: Partial<GateJobInput> = {}): GateJobInput => ({
  ...ctx,
  key: "unit",
  command: "pnpm test",
  ...over,
});

const withFakes = (
  exec: ReturnType<typeof fakeExec>,
  artifacts: ReturnType<typeof fakeArtifacts> = fakeArtifacts(),
) => Layer.mergeAll(exec.layer, artifacts.layer);

describe("a gate job", () => {
  it("[FD-GATE-013] sets FD_REPO, FD_SHA, FD_REF and FD_JOB in the job's environment", async () => {
    const exec = fakeExec();
    await run(runGateJob(job()).pipe(Effect.provide(withFakes(exec))));
    const command = exec.ran.find((r) => r.command === "pnpm test")!;
    expect(command.env).toMatchObject({
      FD_REPO: ctx.repo,
      FD_SHA: SHA,
      FD_REF: ctx.ref,
      FD_JOB: "unit",
    });
  });

  it("[FD-GATE-014] places no executor secret in the job's environment", async () => {
    process.env["FD_TEST_SECRET"] = "held by the executor";
    try {
      const exec = fakeExec();
      await run(runGateJob(job()).pipe(Effect.provide(withFakes(exec))));
      for (const r of exec.ran) expect(Object.values(r.env)).not.toContain("held by the executor");
    } finally {
      delete process.env["FD_TEST_SECRET"];
    }
  });

  it("[FD-GATE-027] runs the install once before the command, with a 600 s timeout", async () => {
    const exec = fakeExec();
    await run(
      runGateJob(job({ install: "pnpm install --frozen-lockfile" })).pipe(
        Effect.provide(withFakes(exec)),
      ),
    );
    const commands = exec.ran.map((r) => r.command).filter((c) => !c.startsWith("git"));
    expect(commands).toEqual(["pnpm install --frozen-lockfile", "pnpm test"]);
    expect(exec.ran.find((r) => r.command.startsWith("pnpm install"))!.timeoutMs).toBe(600_000);
  });

  it("[FD-GATE-028] records install: exit <code> and runs no job command", async () => {
    const exec = fakeExec([{ match: "pnpm install", exit: CommandExit.Exited({ code: 1 }) }]);
    const outcome = await run(
      runGateJob(job({ install: "pnpm install" })).pipe(Effect.provide(withFakes(exec))),
    );
    expect(outcome).toEqual({ _tag: "failure", reason: "install: exit 1" });
    expect(exec.ran.map((r) => r.command)).not.toContain("pnpm test");
  });

  it("[FD-GATE-011] uploads the redacted output as <job key>.log before the verdict", async () => {
    const exec = fakeExec([
      { match: "pnpm test", output: "token ghp_abcdefghijklmnopqrstuvwxyz0123 ok\n" },
    ]);
    const artifacts = fakeArtifacts();
    await run(runGateJob(job()).pipe(Effect.provide(withFakes(exec, artifacts))));
    expect(artifacts.uploads.get("unit.log")).toBe("token [redacted] ok\n");
  });

  it("[FD-GATE-012] returns the same verdict when the log upload fails", async () => {
    for (const code of [0, 4]) {
      const script = [{ match: "pnpm test", exit: CommandExit.Exited({ code }) }];
      const ok = await run(
        runGateJob(job()).pipe(Effect.provide(withFakes(fakeExec(script), fakeArtifacts()))),
      );
      const failedUpload = await run(
        runGateJob(job()).pipe(
          Effect.provide(withFakes(fakeExec(script), fakeArtifacts({ fail: true }))),
        ),
      );
      expect(failedUpload).toEqual(ok);
    }
  });

  it("[FD-GATE-018] refuses a timeoutSec outside 1 s to the run ceiling and runs no command", async () => {
    for (const timeoutSec of [0, 3601, 1.5]) {
      const exec = fakeExec();
      const outcome = await run(
        runGateJob(job({ timeoutSec })).pipe(Effect.provide(withFakes(exec))),
      );
      expect(outcome).toEqual({ _tag: "failure", reason: "config: timeoutSec" });
      expect(exec.ran).toEqual([]);
    }
  });

  it("[FD-GATE-017] skips a draft pull request and an excluded author without a command", async () => {
    const cases = [
      [{ pullRequest: { draft: true, author: "a" } }, "draft-pr"],
      [{ pullRequest: { draft: false, author: "dependabot[bot]" } }, "author-excluded"],
      [{ pullRequest: { draft: false, author: "bot" }, skipAuthors: ["bot"] }, "author-excluded"],
    ] as const;
    for (const [over, detail] of cases) {
      const exec = fakeExec();
      const outcome = await run(runGateJob(job(over)).pipe(Effect.provide(withFakes(exec))));
      expect(outcome).toEqual({ _tag: "skipped", detail });
      expect(exec.ran).toEqual([]);
    }
    const exec = fakeExec();
    const outcome = await run(
      runGateJob(
        job({ pullRequest: { draft: false, author: "dependabot[bot]" }, skipAuthors: [] }),
      ).pipe(Effect.provide(withFakes(exec))),
    );
    expect(outcome).toEqual({ _tag: "success" });
  });

  it("[FD-GATE-015] restores and saves cache entries only through the lease-bound cache", async () => {
    const calls: string[] = [];
    const cache = Layer.succeed(GateCache, {
      restore: (entry: CacheEntry) =>
        Effect.sync(() => (calls.push(`restore ${entry.key}`), false)),
      save: (entry: CacheEntry) => Effect.sync(() => void calls.push(`save ${entry.key}`)),
    });
    const entry = { key: "pnpm-store", paths: [".pnpm-store"] };
    await run(
      runGateJob(job({ cache: [entry] })).pipe(
        Effect.provide(Layer.mergeAll(withFakes(fakeExec()), cache)),
      ),
    );
    expect(calls).toEqual(["restore pnpm-store", "save pnpm-store"]);
    calls.length = 0;
    await run(
      runGateJob(job({ cache: [entry] })).pipe(
        Effect.provide(
          Layer.mergeAll(
            withFakes(fakeExec([{ match: "pnpm test", exit: CommandExit.Exited({ code: 1 }) }])),
            cache,
          ),
        ),
      ),
    );
    expect(calls).toEqual(["restore pnpm-store"]);
  });

  it("[FD-GATE-081] stages the changed files that match writeback paths on a flare-dispatch/ branch", async () => {
    const status = " M test/fixtures/a.json\0?? test/fixtures/new.json\0 M src/index.ts\0";
    const exec = fakeExec([{ match: "git status", output: status }], {
      "test/fixtures/a.json": '{"a":1}\n',
      "test/fixtures/new.json": "{}\n",
    });
    const artifacts = fakeArtifacts();
    const outcome = await run(
      runGateJob(
        job({
          key: "refresh-fixtures",
          writeback: { branch: "fixtures", paths: ["test/fixtures/**"] },
        }),
      ).pipe(Effect.provide(withFakes(exec, artifacts))),
    );
    expect(outcome).toEqual({ _tag: "success" });
    const manifest = JSON.parse(artifacts.uploads.get("staged-write.json")!) as {
      branch: string;
      baseCommit: string;
      entries: { path: string; digest: string }[];
    };
    expect(manifest.branch).toBe("flare-dispatch/fixtures");
    expect(manifest.baseCommit).toBe(SHA);
    expect(manifest.entries.map((e) => e.path)).toEqual([
      "test/fixtures/a.json",
      "test/fixtures/new.json",
    ]);
    for (const e of manifest.entries)
      expect(artifacts.uploads.has(`staged-write/blobs/${e.digest}`)).toBe(true);
    expect(writebackBranch("flare-dispatch/x")).toBe("flare-dispatch/x");
  });

  it("[FD-GATE-081] stages nothing for a failed job", async () => {
    const exec = fakeExec([{ match: "pnpm test", exit: CommandExit.Exited({ code: 1 }) }]);
    const artifacts = fakeArtifacts();
    await run(
      runGateJob(job({ writeback: { branch: "x", paths: ["**"] } })).pipe(
        Effect.provide(withFakes(exec, artifacts)),
      ),
    );
    expect(artifacts.uploads.has("staged-write.json")).toBe(false);
  });
});

describe("check", () => {
  it("[FD-GATE-021] refuses a bad label and runs no command", async () => {
    for (const label of ["-lead", "has space", "x".repeat(33)]) {
      const exec = fakeExec();
      const outcome = await run(
        runCheck({ ...ctx, steps: [{ label, command: "true" }] }).pipe(
          Effect.provide(withFakes(exec)),
        ),
      );
      expect(outcome).toEqual({ _tag: "failure", reason: "config: label" });
      expect(exec.ran).toEqual([]);
    }
  });

  it("[FD-GATE-019] runs a step with its timeoutSec, 600 s by default", async () => {
    const exec = fakeExec();
    await run(
      runCheck({
        ...ctx,
        steps: [
          { label: "a", command: "one" },
          { label: "b", command: "two", timeoutSec: 30 },
        ],
      }).pipe(Effect.provide(withFakes(exec))),
    );
    expect(exec.ran.filter((r) => !r.command.startsWith("git")).map((r) => r.timeoutMs)).toEqual([
      600_000, 30_000,
    ]);
  });
});

describe("oxlint", () => {
  it("[FD-GATE-022] runs npx --yes oxlint@<version> with no install and a 300 s timeout", async () => {
    const exec = fakeExec();
    await run(runOxlint({ ...ctx, version: "1.2.3" }).pipe(Effect.provide(withFakes(exec))));
    await run(runOxlint({ ...ctx }).pipe(Effect.provide(withFakes(exec))));
    const lint = exec.ran.filter((r) => !r.command.startsWith("git"));
    expect(lint.map((r) => r.command)).toEqual([
      "npx --yes oxlint@1.2.3",
      `npx --yes oxlint@${OXLINT_PINNED_VERSION}`,
    ]);
    expect(lint.every((r) => r.timeoutMs === 300_000)).toBe(true);
  });

  it("[FD-GATE-023] refuses a version that is not x.y.z and runs no command", async () => {
    const exec = fakeExec();
    const outcome = await run(
      runOxlint({ ...ctx, version: "latest" }).pipe(Effect.provide(withFakes(exec))),
    );
    expect(outcome).toEqual({ _tag: "failure", reason: "config: oxlint version" });
    expect(exec.ran).toEqual([]);
  });

  it("[FD-GATE-024] skips when oxlint finds nothing to lint", async () => {
    const exec = fakeExec([{ match: "oxlint", output: "No files found to lint\n" }]);
    const outcome = await run(runOxlint({ ...ctx }).pipe(Effect.provide(withFakes(exec))));
    expect(outcome).toEqual({ _tag: "skipped", detail: "nothing-to-lint" });
  });
});
