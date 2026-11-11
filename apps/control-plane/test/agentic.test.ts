// The actuators: the agentic `pr.propose` and `pr.close` appliers over the GitHub package's actuator.
import {
  GitData,
  GitDataError,
  StagedWriteReadFailed,
  WritebackRecords,
} from "@fractalboxdev/flare-dispatch-agentic";
import { lookupRun } from "@fractalboxdev/flare-dispatch-catalog";
import {
  d1IntakeStore,
  IntakeStore,
  type IntakeRecord,
} from "@fractalboxdev/flare-dispatch-intake";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { Actuators, actuatorRegistry, type IntentRow } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { issuedCredentials, writebackApplier } from "../src/agentic.ts";
import { leaseCacheAt } from "../src/cache-execution.ts";
import type { ControlPlaneEnv } from "../src/config.ts";

const row = (kind: string, payload: unknown): IntentRow =>
  ({
    executionId: "01EXEC",
    epoch: 1,
    intentKey: kind,
    kind,
    scopeId: "acme/widgets",
    limitKey: "installation:1",
    payload,
  }) as unknown as IntentRow;

/** The profile's binding for each kind these tests apply. */
const BINDING: Readonly<Record<string, string>> = {
  "pr.propose": "pullRequest",
  "pr.close": "pullRequest",
  "check.conclude": "checkRun",
};

const base = (seen: string[]) => {
  const actuator = {
    apply: (r: IntentRow) =>
      Effect.sync(() => (seen.push(r.kind), { _tag: "applied" as const, externalRef: "base" })),
    lookup: () => Effect.succeed({ _tag: "absent" as const }),
    reconcile: () => Effect.succeed({ _tag: "absent" as const }),
  };
  return Layer.succeed(Actuators, actuatorRegistry({ checkRun: actuator, pullRequest: actuator }));
};

/** Git data whose every call fails as GitHub refusing it, so a routed row answers the agentic applier's refusal. */
const refusingGit = Layer.succeed(
  GitData,
  new Proxy({} as GitData["Service"], {
    get: (_target, call) => () =>
      Effect.fail(new GitDataError({ call: String(call), status: 403, detail: "refused" })),
  }),
);

/** Records whose every read fails; no routed row in these tests reaches them. */
const unreadRecords = Layer.succeed(WritebackRecords, {
  blobs: () => Effect.fail(new StagedWriteReadFailed({ source: "artifacts", detail: "unread" })),
  modelCalls: () => Effect.fail(new StagedWriteReadFailed({ source: "gateway", detail: "unread" })),
  issuedCredentials: () =>
    Effect.fail(new StagedWriteReadFailed({ source: "credentials", detail: "unread" })),
});

const applierWith = (seen: string[]) =>
  writebackApplier("flare-dispatch[bot]").pipe(
    Layer.provide(Layer.mergeAll(base(seen), refusingGit, unreadRecords)),
  );

const apply = (seen: string[], r: IntentRow) =>
  Effect.runPromise(
    Effect.flatMap(Actuators, (a) => a.get(BINDING[r.kind]!)!.apply(r)).pipe(
      Effect.provide(applierWith(seen)),
    ),
  );

describe("the writeback appliers inside every actuator", () => {
  it("[FD-AGT-009] routes pr.close to the agentic applier, which checks its branch before any GitHub call", async () => {
    const seen: string[] = [];
    const answer = await apply(
      seen,
      row("pr.close", { repo: { owner: "acme", name: "widgets" }, branch: "main", base: "main" }),
    );
    expect(seen).toEqual([]);
    expect(answer).toMatchObject({ _tag: "refused", reason: "writeback: branch-invalid" });
  });

  it("[FD-AGT-009] refuses a pr.propose whose payload does not decode, without the GitHub applier", async () => {
    const seen: string[] = [];
    expect(await apply(seen, row("pr.propose", {}))).toMatchObject({
      _tag: "refused",
      reason: "writeback: payload-invalid",
    });
    expect(seen).toEqual([]);
  });

  it("[FD-GH-001] leaves every other kind to the GitHub package's applier", async () => {
    const seen: string[] = [];
    expect(await apply(seen, row("check.conclude", {}))).toMatchObject({ externalRef: "base" });
    expect(seen).toEqual(["check.conclude"]);
  });

  it("[FD-AGT-001] lists each agentic recipe with a body in the catalogue, on a cloud executor", () => {
    for (const name of ["pr-review", "improve-pr", "spec-drift-pr", "ci-triage-pr"]) {
      const found = lookupRun("production", name);
      expect(found._tag).toBe("Available");
      if (found._tag !== "Available") continue;
      expect(found.entry.executors).toEqual(["cloud"]);
      expect(found.entry.agentic?.declaration.needsModel).toBeDefined();
    }
    expect(lookupRun("production", "release-notes")._tag).toBe("NotInCatalogue");
  });
});

const intakeRecord: IntakeRecord = {
  executionId: "x1",
  trigger: "webhook",
  run: "spec-drift-pr",
  label: null,
  repo: "acme/widgets",
  sha: "a".repeat(40),
  ref: "refs/pull/7/head",
  inputs: {},
  deadlineAtMs: 1_900_000_000_000,
  className: "batch",
  labels: [],
  attempt: 1,
  familyRoot: "x1",
  installation: null,
  caller: null,
  notBefore: null,
  spendLine: null,
  placementConstraint: null,
  cacheTrigger: { _tag: "PullRequest", number: 7 },
  eligibleKinds: null,
  createdAt: 0,
};

describe("the issued-credential read", () => {
  const leased = async () => {
    const db = await migratedD1();
    await Effect.runPromise(
      Effect.flatMap(IntakeStore, (s) => s.put(intakeRecord)).pipe(
        Effect.provide(d1IntakeStore(db)),
      ),
    );
    for (const sql of [
      "insert into executions (id, scope_id, run, status, enqueued_at) values ('x1', 'acme/widgets', 'spec-drift-pr', 'success', 0)",
      `insert into executors (executor_id, kind, posture_tier, labels_json, slots_json)
         values ('c1', 'cloudflare', 'unmanaged', '[]', '{}')`,
      "insert into placements (execution_id, state, epoch, executor_id, accepted_epoch) values ('x1', 'accepted', 2, 'c1', 2)",
      `insert into lease_records (execution_id, epoch, class, executor_id, executor_kind, "end", ended_at)
         values ('x1', 1, 'batch', 'd1', 'device', 'reclaimed', 5)`,
    ])
      await db.prepare(sql).run();
    return db;
  };

  it("answers the compile-cache token of every lease the execution held, recomputed from intake's record", async () => {
    const env = {
      DB: await leased(),
      PUBLIC_ORIGIN: "https://cp.example",
      COMPILE_CACHE_SECRET: "secret",
    } as unknown as ControlPlaneEnv;
    const tokens = await Effect.runPromise(issuedCredentials(env)("x1"));
    const expected = await Promise.all(
      [
        { epoch: 1, kind: "device" },
        { epoch: 2, kind: "cloudflare" },
      ].map(
        async (lease) =>
          (await leaseCacheAt(env, intakeRecord, lease)).upload_grant.compile_cache?.token,
      ),
    );
    expect(expected.every((t) => typeof t === "string" && t.startsWith("cc3."))).toBe(true);
    expect([...tokens].sort()).toEqual([...expected].sort());
  });

  it("fails, never answers empty, when intake holds no record of the execution", async () => {
    const env = {
      DB: await leased(),
      COMPILE_CACHE_SECRET: "secret",
    } as unknown as ControlPlaneEnv;
    const failure = await Effect.runPromise(Effect.flip(issuedCredentials(env)("x2")));
    expect(failure).toMatchObject({ _tag: "StagedWriteReadFailed", source: "credentials" });
  });
});
