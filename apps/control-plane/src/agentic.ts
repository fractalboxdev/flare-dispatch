// The agentic area on the control plane: the local-work ports over the D1 database with the reads they take from the
// control plane, the staged write's records, and the `pr.propose` and `pr.close` appliers inside every registered
// actuator. A read this deploy cannot make fails, so no caller decides on an answer that was never read.
import {
  CapacityUsage,
  GitData,
  GitDataError,
  gitDataLayer,
  LOCAL_STORE_MIGRATIONS,
  localPortsLayer,
  ReuseInputs,
  ReuseReadFailed,
  StagedWriteReadFailed,
  WritebackRecords,
  writebackAppliers,
  writebackRecordsLayer,
} from "@fractalboxdev/flare-dispatch-agentic";
import { artifactPath } from "@fractalboxdev/flare-dispatch-cache";
import { d1IntakeStore, IntakeStore } from "@fractalboxdev/flare-dispatch-intake";
import { lookupRun } from "@fractalboxdev/flare-dispatch-catalog";
import { GithubApp, GithubRead, tokenFromApp } from "@fractalboxdev/flare-dispatch-github";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare";
import {
  type Actuator,
  Actuators,
  actuatorRegistry,
  PostureSource,
  type IntentRow,
  type LookupAnswer,
} from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { leaseCacheAt, type LeaseOf } from "./cache-execution.ts";
import { deployment, type ControlPlaneEnv } from "./config.ts";
import { boundFetch } from "./github.ts";

let migrated: Promise<unknown> | undefined;

/** The local-work tables (FD-LOCAL-018). */
export const migrateLocalStore = (db: D1Like) =>
  (migrated ??= (async () => {
    for (const m of LOCAL_STORE_MIGRATIONS) for (const sql of m.sql) await db.prepare(sql).run();
  })().catch((e: unknown) => {
    migrated = undefined;
    throw e;
  }));

/** The posture the registry records for a device enrolled with no posture source. */
export const postureLayer = Layer.succeed(PostureSource, {
  posture: () => Effect.succeed("unmanaged" as const),
});

/**
 * The reuse policy's reads. The required set comes from GitHub; no repository's manifest declares a reuse block and
 * mameko issues no capacity lease, so those two reads fail and the policy names no rehearsal (FD-LOCAL-080).
 */
export const reuseInputsLayer = Layer.effect(
  ReuseInputs,
  Effect.gen(function* () {
    const github = yield* GithubRead;
    return {
      repoPolicy: (repository: string) =>
        Effect.fail(
          new ReuseReadFailed({
            source: "manifest",
            detail: `no reuse block is read for ${repository}`,
          }),
        ),
      readRequiredSet: (repository: string, branch: string) =>
        github
          .requiredChecks(repository, branch)
          .pipe(Effect.mapError((e) => new ReuseReadFailed({ source: "github", detail: e._tag }))),
      epochIssued: () =>
        Effect.fail(
          new ReuseReadFailed({ source: "capacity", detail: "mameko issues no capacity lease" }),
        ),
    };
  }),
);

/**
 * The compile-cache token of every lease the execution held, recomputed from intake's record: the one credential a
 * lease carries (FD-AGT-029). A missing record fails the read, so the secret scan never runs without them.
 */
export const issuedCredentials = (env: ControlPlaneEnv) => (executionId: string) =>
  Effect.gen(function* () {
    const failed = (detail: string) => new StagedWriteReadFailed({ source: "credentials", detail });
    const record = yield* (yield* IntakeStore)
      .get(executionId)
      .pipe(Effect.mapError((e) => failed(e.message)));
    if (record === null) return yield* failed(`no intake record for ${executionId}`);
    const leases = yield* Effect.tryPromise({
      try: async () =>
        (
          await env.DB.prepare(
            `select epoch, executor_kind as kind from lease_records where execution_id = ?1
             union select p.epoch, x.kind from placements p
               left join executors x on x.executor_id = p.executor_id where p.execution_id = ?1`,
          )
            .bind(executionId)
            .all()
        ).results as LeaseOf[],
      catch: (cause) => failed(String(cause)),
    });
    const tokens: string[] = [];
    for (const lease of leases) {
      const grant = yield* Effect.tryPromise({
        try: () => leaseCacheAt(env, record, lease),
        catch: (cause) => failed(String(cause)),
      });
      const token = grant.upload_grant.compile_cache?.token;
      if (token !== undefined) tokens.push(token);
    }
    return tokens;
  }).pipe(Effect.provide(d1IntakeStore(env.DB)));

/**
 * The staged write's records: its blobs from the `CACHE` bucket's `artifacts/` prefix, the gateway's model calls and
 * the issued credentials (FD-AGT-013). A deploy that binds no `CACHE` bucket fails every blob read.
 */
export const writebackRecords = (env: ControlPlaneEnv) =>
  writebackRecordsLayer({
    db: env.DB,
    artifacts: env.CACHE,
    artifactPath,
    issuedCredentials: issuedCredentials(env),
  });

/** A capacity lease's usage report is mameko's, which it does not send yet. */
export const capacityUsageDeferred = Layer.succeed(CapacityUsage, {
  modelCalls: () =>
    Effect.fail(
      new StagedWriteReadFailed({ source: "capacity", detail: "mameko sends no usage report" }),
    ),
});

/** Git data under the installation token of the repository a row targets. */
export const gitData = Layer.unwrap(
  Effect.gen(function* () {
    const app = yield* GithubApp;
    const read = yield* GithubRead;
    const token = tokenFromApp(app);
    return gitDataLayer({
      fetch: boundFetch,
      token: (scopeId) =>
        read.installation(scopeId).pipe(
          Effect.flatMap((installation) => token(installation, false)),
          Effect.mapError(
            (e) => new GitDataError({ call: "installation token", status: 0, detail: e._tag }),
          ),
        ),
    });
  }),
);

/** Without the App no installation token exists, so every git data call fails before it reaches GitHub. */
export const gitDataWithoutApp = gitDataLayer({
  fetch: boundFetch,
  token: () =>
    Effect.fail(
      new GitDataError({ call: "installation token", status: 0, detail: "no GitHub App" }),
    ),
});

/** The local-work ports: `LocalRegistration`, `ReusePolicy` and `WritebackGate`, with every read they take. */
export const localPorts = (env: ControlPlaneEnv) =>
  localPortsLayer({
    db: env.DB,
    runKnown: (run) => lookupRun(deployment(env), run)._tag === "Available",
  }).pipe(
    Layer.provide(
      Layer.mergeAll(reuseInputsLayer, postureLayer, writebackRecords(env), capacityUsageDeferred),
    ),
  );

const WRITEBACK_KINDS: ReadonlySet<string> = new Set(["pr.propose", "pr.close"]);

/**
 * The actuators the drainer calls: in each registered actuator, `pr.propose` and `pr.close` go to the agentic appliers
 * and every other kind to the GitHub package's actuator underneath.
 */
export const writebackApplier = (appLogin: string) =>
  Layer.effect(
    Actuators,
    Effect.gen(function* () {
      const base = yield* Actuators;
      const context = yield* Effect.context<GitData | WritebackRecords>();
      const writeback = writebackAppliers(appLogin);
      const ours = (row: IntentRow) => WRITEBACK_KINDS.has(row.kind);
      const wrap = (a: Actuator): Actuator => ({
        apply: (row: IntentRow) =>
          ours(row)
            ? (row.kind === "pr.propose"
                ? writeback["pr.propose"].apply(row)
                : writeback["pr.close"].apply(row)
              ).pipe(Effect.provide(context))
            : a.apply(row),
        lookup: (row: IntentRow): Effect.Effect<LookupAnswer> =>
          row.kind === "pr.propose"
            ? writeback["pr.propose"].lookup(row).pipe(Effect.provide(context))
            : row.kind === "pr.close"
              ? Effect.succeed({
                  _tag: "undetermined" as const,
                  reason: "pr.close is replay-safe and has no lookup",
                })
              : a.lookup === undefined
                ? Effect.succeed({
                    _tag: "undetermined" as const,
                    reason: `${row.kind}: the actuator has no lookup`,
                  })
                : a.lookup(row),
        ...(a.reconcile === undefined
          ? {}
          : {
              reconcile: (row: IntentRow) =>
                ours(row)
                  ? Effect.succeed({
                      _tag: "undetermined" as const,
                      reason: `${row.kind} is not reconcile-only`,
                    })
                  : a.reconcile!(row),
            }),
      });
      return actuatorRegistry(
        Object.fromEntries(base.names().map((name) => [name, wrap(base.get(name)!)])),
      );
    }),
  );
