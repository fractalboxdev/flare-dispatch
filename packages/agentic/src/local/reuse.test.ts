import { createHash } from "node:crypto";
import { PostureSource, ReusePolicy, WritebackGate } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Manifest, WritebackSpec } from "../staged-write/manifest.ts";
import { WritebackRecords, StagedWriteReadFailed, type LoadedBlob } from "../writeback/applier.ts";
import { BASE_SHA, fakeGitLayer, fakeRepo } from "../writeback/fake-git.test-support.ts";
import { memoryD1 } from "./d1.test-support.ts";
import {
  rehearsalSummary,
  ReuseInputs,
  ReuseReadFailed,
  reusePolicyLayer,
  type RepoReusePolicy,
} from "./reuse.ts";
import { LocalStore, localStoreD1, type RegistrationRecord } from "./store.ts";
import {
  CapacityUsage,
  decideWriteback,
  writebackAck,
  writebackGateLayer,
} from "./writeback-gate.ts";

const record = (over: Partial<RegistrationRecord> = {}): RegistrationRecord => ({
  executionId: "01HREHEARSAL00000000000000",
  scopeId: "scope",
  executorId: "dev-1",
  leaseId: "L1",
  epoch: 2,
  run: "check",
  reuseKey: "rk",
  repository: "o/r",
  treeHash: "tree",
  baseCommit: BASE_SHA,
  runDigest: "sha256:run",
  imageDigest: "sha256:img",
  platform: "darwin-arm64",
  inputsDigest: "sha256:in",
  environmentNames: ["CI"],
  wantsReuse: true,
  wantsWriteback: true,
  nonce: "n",
  registeredAt: 1000,
  startedAt: 2000,
  outcome: "success",
  statementId: "stmt-1",
  statementAccepted: true,
  ...over,
});

const request = {
  scopeId: "scope",
  repository: "o/r",
  baseBranch: "main",
  checkName: "flare-dispatch/check:lint",
  run: "check",
  placementRule: "local-first",
  intentKinds: ["check.summary"],
  treeHash: "tree",
  baseCommit: BASE_SHA,
  runDigest: "sha256:run",
  imageDigest: "sha256:img",
  platform: "darwin-arm64",
  inputsDigest: "sha256:in",
  environmentNames: ["CI"],
};

interface Knobs {
  policy?: RepoReusePolicy | "fail";
  required?: readonly string[] | "fail";
  epochIssued?: boolean;
  posture?: "attested-dedicated" | "managed-workstation" | "unmanaged" | "failing";
}

const reuseHarness = async (records: readonly RegistrationRecord[], knobs: Knobs = {}) => {
  const store = localStoreD1(memoryD1());
  const reads = { required: 0 };
  const inputs = Layer.succeed(ReuseInputs, {
    repoPolicy: () =>
      knobs.policy === "fail"
        ? Effect.fail(new ReuseReadFailed({ source: "manifest", detail: "x" }))
        : Effect.succeed(knobs.policy ?? { reuse: true, equivalentPlatforms: [] }),
    readRequiredSet: () =>
      Effect.suspend(() => {
        reads.required++;
        return knobs.required === "fail"
          ? Effect.fail(new ReuseReadFailed({ source: "github", detail: "x" }))
          : Effect.succeed(knobs.required ?? []);
      }),
    epochIssued: () => Effect.succeed(knobs.epochIssued ?? true),
  });
  const posture = Layer.succeed(PostureSource, {
    posture: () => Effect.succeed(knobs.posture ?? "managed-workstation"),
  });
  const layer = Layer.merge(
    reusePolicyLayer.pipe(Layer.provide(Layer.mergeAll(store, inputs, posture))),
    store,
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const s = yield* LocalStore;
      for (const r of records) yield* s.insert(r);
    }).pipe(Effect.provide(store)),
  );
  const ask = (req: unknown = request) =>
    Effect.gen(function* () {
      const policy = yield* ReusePolicy;
      return yield* policy.reuse(req, "rk");
    });
  const reuse = (req: unknown = request) => ask(req).pipe(Effect.provide(layer));
  return { reuse, ask, layer, reads };
};

const reuse = async (
  records: readonly RegistrationRecord[],
  knobs: Knobs = {},
  req: unknown = request,
) => Effect.runPromise((await reuseHarness(records, knobs)).reuse(req));

describe("reuse policy", () => {
  it("[FD-LOCAL-078] names a registered rehearsal that matches on every field and carries an accepted statement", async () => {
    expect(await reuse([record()])).toBe("01HREHEARSAL00000000000000");
  });

  it("[FD-LOCAL-077] names none unless the repository turns reuse on", async () => {
    expect(
      await reuse([record()], { policy: { reuse: false, equivalentPlatforms: [] } }),
    ).toBeNull();
    expect(await reuse([record()], { policy: "fail" })).toBeNull();
  });

  it("[FD-LOCAL-078] names none when any condition fails (simulation over single-field changes)", async () => {
    const breaks: readonly Partial<RegistrationRecord>[] = [
      { startedAt: null },
      { startedAt: 500 },
      { statementAccepted: false },
      { statementId: null },
      { outcome: "failure" },
      { treeHash: "other" },
      { baseCommit: "c".repeat(40) },
      { runDigest: "sha256:other" },
      { imageDigest: "sha256:other" },
      { platform: "linux-arm64" },
      { environmentNames: ["CI", "EXTRA"] },
      { run: "other" },
    ];
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...breaks),
        async (broken) => (await reuse([record(broken)])) === null,
      ),
      { numRuns: 60 },
    );
    expect(await reuse([record()], { epochIssued: false })).toBeNull();
    // The newest candidate that holds is named, past one that does not.
    expect(
      await reuse([
        record({ executionId: "A".repeat(26) }),
        record({ executionId: "B".repeat(26), registeredAt: 1500, treeHash: "x" }),
      ]),
    ).toBe("A".repeat(26));
  });

  it("[FD-LOCAL-079] names none for a check in the base branch's required set", async () => {
    expect(await reuse([record()], { required: ["flare-dispatch/check:lint"] })).toBeNull();
  });

  it("[FD-LOCAL-080] names none when the required-set read fails", async () => {
    expect(await reuse([record()], { required: "fail" })).toBeNull();
  });

  it("[FD-LOCAL-081] reads the required set again once the cached set is older than 10 min", async () => {
    const h = await reuseHarness([record()]);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.ask();
        yield* h.ask();
        expect(h.reads.required).toBe(1);
        yield* TestClock.adjust("599 seconds");
        yield* h.ask();
        expect(h.reads.required).toBe(1);
        yield* TestClock.adjust("2 seconds");
        yield* h.ask();
        expect(h.reads.required).toBe(2);
      }).pipe(Effect.provide(h.layer), Effect.provide(TestClock.layer())),
    );
  });

  it("[FD-LOCAL-082] names none for a cloud-only placement rule", async () => {
    expect(await reuse([record()], {}, { ...request, placementRule: "cloud-only" })).toBeNull();
  });

  it("[FD-LOCAL-083] names none for a run requesting an intent other than its own check", async () => {
    for (const kind of ["pr.propose", "release.publish", "comment"])
      expect(
        await reuse([record()], {}, { ...request, intentKinds: ["check.summary", kind] }),
      ).toBeNull();
  });

  it("[FD-LOCAL-084] names a rehearsal on another platform only when the repository names both equivalent", async () => {
    const other = { ...request, platform: "linux-arm64" };
    expect(await reuse([record()], {}, other)).toBeNull();
    expect(
      await reuse(
        [record()],
        { policy: { reuse: true, equivalentPlatforms: [["darwin-arm64", "linux-arm64"]] } },
        other,
      ),
    ).toBe("01HREHEARSAL00000000000000");
  });

  it("[FD-LOCAL-085] names none signed by a device whose posture is unmanaged", async () => {
    expect(await reuse([record()], { posture: "unmanaged" })).toBeNull();
  });

  it("[FD-LOCAL-086] the check summary names the rehearsal, the device and the statement", () => {
    expect(rehearsalSummary(record())).toBe(
      "A rehearsal produced this verdict: local execution 01HREHEARSAL00000000000000 on device dev-1, device-signed statement stmt-1.",
    );
  });
});

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const enc = (t: string) => new TextEncoder().encode(t);
const writeback: WritebackSpec = {
  branch: "flare-dispatch/fix",
  baseBranch: "main",
  allowlist: ["src/**"],
  allowSensitivePaths: false,
  allowWorkflows: false,
};
const manifest = (files: Record<string, string>, over: Partial<Manifest> = {}): Manifest => ({
  branch: "flare-dispatch/fix",
  baseBranch: "main",
  baseCommit: BASE_SHA,
  message: "fix",
  pr: { title: "Fix", body: "b", draft: true, labels: ["device-signed"] },
  entries: Object.entries(files).map(([path, text]) => ({
    path,
    mode: "100644",
    digest: sha(text),
  })),
  ...over,
});

const gateHarness = async (
  opts: {
    records?: RegistrationRecord[];
    files?: Record<string, string>;
    modelCalls?: boolean;
    usageFails?: boolean;
  } = {},
) => {
  const files = opts.files ?? { "src/a.ts": "a" };
  const store = localStoreD1(memoryD1());
  const records = Layer.succeed(WritebackRecords, {
    blobs: (_x, entries) =>
      Effect.succeed(
        entries.flatMap((e): LoadedBlob[] => {
          const text = files[e.path];
          return text === undefined
            ? []
            : [{ path: e.path, digest: sha(text), size: text.length, text, bytes: enc(text) }];
        }),
      ),
    modelCalls: () => Effect.succeed(false),
    issuedCredentials: () => Effect.succeed([]),
  });
  const usage = Layer.succeed(CapacityUsage, {
    modelCalls: () =>
      opts.usageFails === true
        ? Effect.fail(new StagedWriteReadFailed({ source: "usage", detail: "x" }))
        : Effect.succeed(opts.modelCalls ?? false),
  });
  const deps = Layer.mergeAll(store, records, usage, fakeGitLayer(fakeRepo()));
  await Effect.runPromise(
    Effect.gen(function* () {
      const s = yield* LocalStore;
      for (const r of opts.records ?? [record()]) yield* s.insert(r);
    }).pipe(Effect.provide(store)),
  );
  const config = { writebackFor: (run: string) => (run === "check" ? writeback : undefined) };
  return {
    decide: (intents: unknown, executionId = record().executionId) =>
      Effect.runPromise(decideWriteback(config, executionId, intents).pipe(Effect.provide(deps))),
    port: (intents: unknown) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const gate = yield* WritebackGate;
          return yield* gate.decide(record().executionId, intents as readonly unknown[]);
        }).pipe(Effect.provide(writebackGateLayer(config).pipe(Layer.provide(deps)))),
      ),
  };
};

const propose = (m: Manifest) => [
  { intent_key: "run:propose:0", kind: "pr.propose", payload: { manifest: m } },
];
const review = [{ intent_key: "run:review:0", kind: "review", payload: { body: "LGTM" } }];

describe("writeback gate", () => {
  it("[FD-LOCAL-087] accepts a registered success's device-signed draft pull request or review, and nothing else", async () => {
    const h = await gateHarness();
    expect(await h.decide(review)).toEqual({ _tag: "accepted" });
    expect(await h.decide(propose(manifest({ "src/a.ts": "a" })))).toEqual({ _tag: "accepted" });
    expect(await h.port(review)).toBe(true);
    expect(await h.decide(review, "unknown")).toEqual({
      _tag: "rejected",
      reason: "not-registered",
    });
    const notDraft = manifest(
      { "src/a.ts": "a" },
      { pr: { title: "t", body: "b", draft: false, labels: ["device-signed"] } },
    );
    expect(await h.decide(propose(notDraft))).toEqual({
      _tag: "rejected",
      reason: "not-a-device-signed-draft",
    });
    const unmarked = manifest(
      { "src/a.ts": "a" },
      { pr: { title: "t", body: "b", draft: true, labels: [] } },
    );
    expect(await h.decide(propose(unmarked))).toEqual({
      _tag: "rejected",
      reason: "not-a-device-signed-draft",
    });
    const failed = await gateHarness({ records: [record({ outcome: "failure" })] });
    expect(await failed.decide(review)).toEqual({
      _tag: "rejected",
      reason: "verdict-not-success",
    });
  });

  it("[FD-LOCAL-088] rejects an intent that opens an issue or pushes to a protected branch", async () => {
    const h = await gateHarness();
    expect(await h.decide([{ intent_key: "run:i:0", kind: "issue", payload: {} }])).toEqual({
      _tag: "rejected",
      reason: "kind-not-allowed: issue",
    });
    expect(await h.decide(propose(manifest({ "src/a.ts": "a" }, { branch: "main" })))).toEqual({
      _tag: "rejected",
      reason: "protected-branch",
    });
    expect(await h.port([{ intent_key: "run:i:0", kind: "issue", payload: {} }])).toBe(false);
  });

  it("[FD-LOCAL-089] answers requests past local_writeback_rate per lease per hour rate_limited with a retry_after", async () => {
    const h = await gateHarness();
    await Effect.runPromise(
      Effect.gen(function* () {
        for (let i = 0; i < 10; i++)
          expect((yield* Effect.promise(() => h.decide(review)))._tag).toBe("accepted");
      }),
    );
    const limited = await h.decide(review);
    expect(limited._tag).toBe("rate_limited");
    expect(writebackAck(limited)).toMatchObject({
      type: "local.writeback.ack",
      status: "rate_limited",
    });
    expect((writebackAck(limited) as { retry_after_ms: number }).retry_after_ms).toBeGreaterThan(0);
    expect(
      (writebackAck(limited) as { retry_after_ms: number }).retry_after_ms,
    ).toBeLessThanOrEqual(3_600_000);
  });

  it("[FD-LOCAL-094] runs stagedWriteGate with the run's writeback block, model-authored from the lease's usage report", async () => {
    const outside = await gateHarness({ files: { "docs/x.md": "x" } });
    const r1 = await outside.decide(propose(manifest({ "docs/x.md": "x" })));
    expect(r1).toEqual({
      _tag: "rejected",
      reason: "writeback: outside-allowlist; outside-allowlist docs/x.md",
    });

    const files = { "src/infra/../x.ts": "x", "src/wrangler.toml": "y" };
    const human = await gateHarness({ files: { "src/wrangler.toml": "y" }, modelCalls: false });
    expect(await human.decide(propose(manifest({ "src/wrangler.toml": "y" })))).toEqual({
      _tag: "accepted",
    });
    const model = await gateHarness({ files: { "src/wrangler.toml": "y" }, modelCalls: true });
    expect(await model.decide(propose(manifest({ "src/wrangler.toml": "y" })))).toEqual({
      _tag: "rejected",
      reason: "writeback: protected-path; protected-path src/wrangler.toml",
    });
    const unknownUsage = await gateHarness({ files, usageFails: true });
    expect(await unknownUsage.decide(propose(manifest({ "src/a.ts": "a" })))).toEqual({
      _tag: "rejected",
      reason: "read-failed: usage",
    });
  });
});
