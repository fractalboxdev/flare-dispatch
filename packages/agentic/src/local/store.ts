// The control plane's records of registered local executions and their writeback requests, in D1
// (specs/local-scheduler.md § Rehearsal and registration, § Writeback from local work).
import { Context, Effect, Layer, Schema } from "effect";

export class LocalStoreFailed extends Schema.TaggedError<LocalStoreFailed>()("LocalStoreFailed", {
  operation: Schema.String,
  detail: Schema.String,
}) {}

/** What a rehearsal tested, as `local.register` carries it (MAMEKO-LOCAL-069, FD-LOCAL-072). */
export const Provenance = Schema.Struct({
  treeHash: Schema.String,
  baseCommit: Schema.String,
  runDigest: Schema.String,
  imageDigest: Schema.String,
  platform: Schema.String,
  inputsDigest: Schema.String,
});
export type Provenance = typeof Provenance.Type;

export interface RegistrationRecord extends Provenance {
  readonly executionId: string;
  readonly scopeId: string;
  readonly executorId: string;
  readonly leaseId: string;
  readonly epoch: number;
  readonly run: string;
  readonly reuseKey: string;
  readonly repository: string;
  readonly environmentNames: readonly string[];
  readonly wantsReuse: boolean;
  readonly wantsWriteback: boolean;
  readonly nonce: string;
  readonly registeredAt: number;
  /** When the job sandbox started, from the device's report; null until it arrives. */
  readonly startedAt: number | null;
  /** The advisory outcome, `success` or another, once reported. */
  readonly outcome: string | null;
  readonly statementId: string | null;
  readonly statementAccepted: boolean;
}

export class LocalStore extends Context.Service<
  LocalStore,
  {
    readonly insert: (record: RegistrationRecord) => Effect.Effect<void, LocalStoreFailed>;
    readonly byExecution: (
      executionId: string,
    ) => Effect.Effect<RegistrationRecord | null, LocalStoreFailed>;
    /** Registered executions with the reuse key in the tenant scope, newest first. */
    readonly byReuseKey: (
      scopeId: string,
      reuseKey: string,
    ) => Effect.Effect<readonly RegistrationRecord[], LocalStoreFailed>;
    readonly recordStart: (
      executionId: string,
      startedAt: number,
    ) => Effect.Effect<void, LocalStoreFailed>;
    readonly recordOutcome: (
      executionId: string,
      outcome: string,
    ) => Effect.Effect<void, LocalStoreFailed>;
    readonly recordStatement: (
      executionId: string,
      statementId: string,
      accepted: boolean,
    ) => Effect.Effect<void, LocalStoreFailed>;
    /** Records one writeback request of a capacity lease and answers how many it made since `since`, this one included. */
    readonly countWriteback: (
      leaseId: string,
      at: number,
      since: number,
    ) => Effect.Effect<{ readonly count: number; readonly oldest: number }, LocalStoreFailed>;
    /** The intent keys mameko's outbox holds as rows of the execution (MAMEKO-PROTO-083). */
    readonly heldIntents: (
      executionId: string,
    ) => Effect.Effect<ReadonlySet<string>, LocalStoreFailed>;
  }
>()("@fractalboxdev/flare-dispatch-agentic/LocalStore") {}

/** The slice of a D1 binding the store uses; mameko's `D1Like` satisfies it. */
export interface D1Binding {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      all(): Promise<{ readonly results: unknown[] }>;
    };
  };
}

/** The store's tables, forward-only. */
export const LOCAL_STORE_MIGRATIONS: readonly {
  readonly name: string;
  readonly sql: readonly string[];
}[] = [
  {
    name: "fd_local_registrations",
    sql: [
      `create table if not exists fd_local_registrations (
        execution_id text primary key,
        scope_id text not null,
        executor_id text not null,
        lease_id text not null,
        epoch integer not null,
        run text not null,
        reuse_key text not null,
        repository text not null,
        tree_hash text not null,
        base_commit text not null,
        run_digest text not null,
        image_digest text not null,
        platform text not null,
        inputs_digest text not null,
        environment_names text not null,
        wants_reuse integer not null,
        wants_writeback integer not null,
        nonce text not null,
        registered_at integer not null,
        started_at integer,
        outcome text,
        statement_id text,
        statement_accepted integer not null default 0
      )`,
      `create index if not exists fd_local_registrations_reuse on fd_local_registrations (scope_id, reuse_key, registered_at)`,
      `create table if not exists fd_local_writebacks (
        lease_id text not null,
        at integer not null
      )`,
      `create index if not exists fd_local_writebacks_lease on fd_local_writebacks (lease_id, at)`,
    ],
  },
];

interface Row {
  readonly [column: string]: unknown;
}

const recordOf = (r: Row): RegistrationRecord => ({
  executionId: r["execution_id"] as string,
  scopeId: r["scope_id"] as string,
  executorId: r["executor_id"] as string,
  leaseId: r["lease_id"] as string,
  epoch: Number(r["epoch"]),
  run: r["run"] as string,
  reuseKey: r["reuse_key"] as string,
  repository: r["repository"] as string,
  treeHash: r["tree_hash"] as string,
  baseCommit: r["base_commit"] as string,
  runDigest: r["run_digest"] as string,
  imageDigest: r["image_digest"] as string,
  platform: r["platform"] as string,
  inputsDigest: r["inputs_digest"] as string,
  environmentNames: JSON.parse(r["environment_names"] as string) as string[],
  wantsReuse: Number(r["wants_reuse"]) === 1,
  wantsWriteback: Number(r["wants_writeback"]) === 1,
  nonce: r["nonce"] as string,
  registeredAt: Number(r["registered_at"]),
  startedAt:
    r["started_at"] === null || r["started_at"] === undefined ? null : Number(r["started_at"]),
  outcome: (r["outcome"] as string | null | undefined) ?? null,
  statementId: (r["statement_id"] as string | null | undefined) ?? null,
  statementAccepted: Number(r["statement_accepted"]) === 1,
});

/** `LocalStore` over the control plane's D1 database, after mameko's store migrations and `LOCAL_STORE_MIGRATIONS`. */
export const localStoreD1 = (db: D1Binding): Layer.Layer<LocalStore> => {
  const run = (operation: string, query: string, ...values: unknown[]) =>
    Effect.tryPromise({
      try: () =>
        db
          .prepare(query)
          .bind(...values)
          .run(),
      catch: (cause) => new LocalStoreFailed({ operation, detail: String(cause) }),
    }).pipe(Effect.asVoid);
  const all = (operation: string, query: string, ...values: unknown[]) =>
    Effect.tryPromise({
      try: () =>
        db
          .prepare(query)
          .bind(...values)
          .all(),
      catch: (cause) => new LocalStoreFailed({ operation, detail: String(cause) }),
    }).pipe(Effect.map((r) => r.results as Row[]));
  return Layer.succeed(LocalStore, {
    insert: (r) =>
      run(
        "insert",
        `insert into fd_local_registrations (execution_id, scope_id, executor_id, lease_id, epoch, run, reuse_key,
           repository, tree_hash, base_commit, run_digest, image_digest, platform, inputs_digest, environment_names,
           wants_reuse, wants_writeback, nonce, registered_at, started_at, outcome, statement_id, statement_accepted)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        r.executionId,
        r.scopeId,
        r.executorId,
        r.leaseId,
        r.epoch,
        r.run,
        r.reuseKey,
        r.repository,
        r.treeHash,
        r.baseCommit,
        r.runDigest,
        r.imageDigest,
        r.platform,
        r.inputsDigest,
        JSON.stringify(r.environmentNames),
        r.wantsReuse ? 1 : 0,
        r.wantsWriteback ? 1 : 0,
        r.nonce,
        r.registeredAt,
        r.startedAt,
        r.outcome,
        r.statementId,
        r.statementAccepted ? 1 : 0,
      ),
    byExecution: (executionId) =>
      Effect.map(
        all(
          "byExecution",
          "select * from fd_local_registrations where execution_id = ?",
          executionId,
        ),
        (rows) => (rows[0] === undefined ? null : recordOf(rows[0])),
      ),
    byReuseKey: (scopeId, reuseKey) =>
      Effect.map(
        all(
          "byReuseKey",
          "select * from fd_local_registrations where scope_id = ? and reuse_key = ? order by registered_at desc",
          scopeId,
          reuseKey,
        ),
        (rows) => rows.map(recordOf),
      ),
    recordStart: (executionId, startedAt) =>
      run(
        "recordStart",
        "update fd_local_registrations set started_at = ? where execution_id = ?",
        startedAt,
        executionId,
      ),
    recordOutcome: (executionId, outcome) =>
      run(
        "recordOutcome",
        "update fd_local_registrations set outcome = ? where execution_id = ?",
        outcome,
        executionId,
      ),
    recordStatement: (executionId, statementId, accepted) =>
      run(
        "recordStatement",
        "update fd_local_registrations set statement_id = ?, statement_accepted = ? where execution_id = ?",
        statementId,
        accepted ? 1 : 0,
        executionId,
      ),
    countWriteback: (leaseId, at, since) =>
      Effect.gen(function* () {
        yield* run(
          "countWriteback",
          "insert into fd_local_writebacks (lease_id, at) values (?, ?)",
          leaseId,
          at,
        );
        yield* run(
          "countWriteback",
          "delete from fd_local_writebacks where lease_id = ? and at < ?",
          leaseId,
          since,
        );
        const rows = yield* all(
          "countWriteback",
          "select count(*) as n, min(at) as oldest from fd_local_writebacks where lease_id = ? and at >= ?",
          leaseId,
          since,
        );
        return { count: Number(rows[0]?.["n"] ?? 0), oldest: Number(rows[0]?.["oldest"] ?? at) };
      }),
    heldIntents: (executionId) =>
      Effect.map(
        all("heldIntents", "select intent_key from outbox where execution_id = ?", executionId),
        (rows) => new Set(rows.map((r) => r["intent_key"] as string)),
      ),
  });
};
