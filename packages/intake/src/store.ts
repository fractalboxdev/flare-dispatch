// FlareDispatch's own intake tables on D1. mameko's admission stores no inputs,
// trigger, attempt or check label (host-cloudflare d1.ts `admitExecution`), and
// a lease, a check re-run and a cancel all need them, so intake keeps one row
// per execution beside mameko's. Cooldown windows, held requests and webhook
// delivery times live here too; shed rows are mameko's `shed` table.
import type { ExecutionRecordFacts } from "@fractalboxdev/flare-dispatch-github";
import { recordShed, type D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import type { IntakeAdmitInput } from "./config.ts";
import { CacheTriggerRecord, OTHER_CACHE_TRIGGER, type RecordedTrigger } from "./event.ts";
import { checkName } from "./runs.ts";

export const INTAKE_MIGRATIONS: readonly string[] = [
  `create table if not exists intake_records (
    execution_id text primary key,
    trigger text not null,
    run text not null,
    label text,
    repo text not null,
    sha text not null,
    ref text not null,
    inputs_json text not null,
    class text not null,
    labels_json text not null,
    attempt integer not null,
    family_root text not null,
    installation integer,
    caller text,
    not_before integer,
    spend_line text,
    placement_constraint text,
    cache_trigger_json text,
    eligible_kinds text,
    repository_public integer,
    input_associations_json text,
    created_at integer not null)`,
  `create index if not exists intake_records_family on intake_records (family_root)`,
  `create index if not exists intake_records_commit on intake_records (repo, sha)`,
  // Admission writes the placement row's eligible kinds itself (MAMEKO-LEASE-015); the trigger that copied them from the
  // record goes, on a database that still has it.
  `drop trigger if exists intake_placement_kinds`,
  `create table if not exists intake_cooldowns (
    bucket text primary key,
    execution_id text not null,
    armed_at integer not null)`,
  `create table if not exists intake_deliveries (
    installation integer primary key,
    verified_at integer not null)`,
  // A request inside its run's cooldown window, held before admission until `not_before` (FD-INT-057). The admission
  // input waits here and the minute tick admits it; one held request per dedup key.
  `create table if not exists intake_held (
    execution_id text primary key,
    sha256 text not null unique,
    request_digest text,
    admit_json text not null,
    cooldown_bucket text not null,
    not_before integer not null)`,
  `create index if not exists intake_held_due on intake_held (not_before)`,
  // When each closed pull request closed, keyed by the lower-cased repository as the cache namespaces name it; a
  // reopen deletes the row. The cache sweep deletes the pull request's namespace a delay after `closed_at`
  // (FD-CACHE-064).
  `create table if not exists intake_pull_request_closes (
    repo text not null,
    number integer not null,
    closed_at integer not null,
    primary key (repo, number))`,
];

export const migrateIntake = (db: D1Like): Effect.Effect<void> =>
  Effect.promise(() => db.batch(INTAKE_MIGRATIONS.map((s) => db.prepare(s)))).pipe(Effect.asVoid);

export interface IntakeRecord {
  readonly executionId: string;
  readonly trigger: RecordedTrigger;
  readonly run: string;
  readonly label: string | null;
  readonly repo: string;
  readonly sha: string;
  readonly ref: string;
  readonly inputs: unknown;
  readonly className: string;
  readonly labels: readonly string[];
  readonly attempt: number;
  /** The id of attempt 1 of the check family; the execution's own id for attempt 1. */
  readonly familyRoot: string;
  readonly installation: number | null;
  readonly caller: string | null;
  /** The end of the cooldown window the execution waits for (FD-INT-057). */
  readonly notBefore: number | null;
  /** The class line the execution's spend counts against when it is not its class's (FD-SPD-032). */
  readonly spendLine: string | null;
  /** `local-only` for a local submit (FD-INT-061). */
  readonly placementConstraint: string | null;
  /** The trigger as the cache namespaces read it (FD-CACHE-019). */
  readonly cacheTrigger: CacheTriggerRecord;
  /**
   * The executor kinds admission wrote on the placement row; empty when admission concluded the execution without one,
   * null until admission answers.
   */
  readonly eligibleKinds: readonly string[] | null;
  /**
   * Whether the repository is public, as the trigger stated it; null when it did not say. A re-run and a follow-on
   * carry it, so the attempt's data classes are the first attempt's (FD-AGT-005).
   */
  readonly repositoryPublic: boolean | null;
  /** The `author_association` of every principal whose text the trigger's payload carries (FD-AGT-005). */
  readonly inputAssociations: readonly string[];
  readonly createdAt: number;
}

/**
 * The request context of an execution: what started the request beside the run inputs, as intake recorded it before
 * admission. A lease carries it as `request_context` (FD-PROF-063).
 */
export interface RequestContext {
  readonly trigger: RecordedTrigger;
  readonly ref: string;
  readonly installation: number | null;
  readonly caller: string | null;
}

/** The request context the record holds. */
export const requestContextOf = (record: IntakeRecord): RequestContext => ({
  trigger: record.trigger,
  ref: record.ref,
  installation: record.installation,
  caller: record.caller,
});

/**
 * A record with mameko's status of its execution: `held` while it waits for its cooldown window before admission, null
 * when admission kept no execution for it.
 */
export interface RecordWithStatus extends IntakeRecord {
  readonly status: string | null;
}

export const HELD_STATUS = "held";

/** A held request: its admission input and the cooldown bucket it arms once admitted. */
export interface HeldRequest {
  readonly admit: IntakeAdmitInput;
  readonly cooldownBucket: string;
  readonly notBefore: number;
}

/** What holding a request found: it was held, or its dedup key already names an execution, held or admitted. */
export type HoldResult =
  | { readonly _tag: "Held" }
  | { readonly _tag: "Known"; readonly executionId: string; readonly requestDigest: string | null };

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "deferred",
  "expired",
]);

export interface ShedRow {
  readonly scopeId: string;
  readonly run: string | null;
  readonly reason: string;
  readonly estimatedCost: number | null;
}

export interface FamilySpend {
  /** Settled cost of settled attempts plus the hold of held ones, micro-USD. */
  readonly spentMicroUsd: number;
  /** The first attempt's hold, null before it was reserved. */
  readonly firstHoldMicroUsd: number | null;
}

/** The store failed; nothing intake decided on it was written. */
export class StoreUnavailable extends Schema.TaggedError<StoreUnavailable>()("StoreUnavailable", {
  message: Schema.String,
}) {}

export class IntakeStore extends Context.Service<
  IntakeStore,
  {
    readonly put: (record: IntakeRecord) => Effect.Effect<void, StoreUnavailable>;
    /**
     * Writes the record and holds its admission input until `notBefore`, unless the dedup key already names an
     * admitted or held execution; then it writes nothing and answers that execution (FD-INT-057).
     */
    readonly hold: (
      record: IntakeRecord,
      held: HeldRequest,
    ) => Effect.Effect<HoldResult, StoreUnavailable>;
    /** Held requests whose window ended at or before `now`, earliest first. */
    readonly due: (
      now: number,
      limit: number,
    ) => Effect.Effect<readonly HeldRequest[], StoreUnavailable>;
    /** Ends the hold of a request admission answered. */
    readonly release: (executionId: string) => Effect.Effect<void, StoreUnavailable>;
    /**
     * Copies the eligible kinds admission wrote on the execution's placement row to its record, or none when admission
     * wrote no placement row. True when the placement row exists: admission queued the execution rather than
     * concluding it.
     */
    readonly placed: (executionId: string) => Effect.Effect<boolean, StoreUnavailable>;
    /** Removes the row of an id admission did not keep. */
    readonly drop: (executionId: string) => Effect.Effect<void, StoreUnavailable>;
    readonly get: (executionId: string) => Effect.Effect<RecordWithStatus | null, StoreUnavailable>;
    /**
     * The record of an admitted execution beside mameko's execution, placement and reservation rows, which its check
     * run's conclusion states; null when either the record or the execution row is missing.
     */
    readonly conclusionFacts: (
      executionId: string,
    ) => Effect.Effect<ExecutionRecordFacts | null, StoreUnavailable>;
    readonly family: (root: string) => Effect.Effect<readonly RecordWithStatus[], StoreUnavailable>;
    readonly atCommit: (
      repo: string,
      sha: string,
    ) => Effect.Effect<readonly RecordWithStatus[], StoreUnavailable>;
    /**
     * The keys of the repository's supersession groups that start with `prefix` and still have a live member, e.g.
     * every group of one pull request (FD-PROF-030).
     */
    readonly liveSupersessionGroups: (
      repo: string,
      prefix: string,
    ) => Effect.Effect<readonly string[], StoreUnavailable>;
    readonly familySpend: (root: string) => Effect.Effect<FamilySpend, StoreUnavailable>;
    readonly cooldown: (
      bucket: string,
    ) => Effect.Effect<
      { readonly executionId: string; readonly armedAt: number } | null,
      StoreUnavailable
    >;
    readonly armCooldown: (
      bucket: string,
      executionId: string,
      at: number,
    ) => Effect.Effect<void, StoreUnavailable>;
    /** The time of the installation's last verified delivery (FD-INT-031). */
    readonly recordDelivery: (
      installation: number,
      at: number,
    ) => Effect.Effect<void, StoreUnavailable>;
    readonly lastDelivery: (installation: number) => Effect.Effect<number | null, StoreUnavailable>;
    /** Records that the pull request closed at `at`; a later close of the same pull request replaces it. */
    readonly pullRequestClosed: (
      repo: string,
      number: number,
      at: number,
    ) => Effect.Effect<void, StoreUnavailable>;
    /** Forgets the close of a reopened pull request, so its namespace is kept again. */
    readonly pullRequestReopened: (
      repo: string,
      number: number,
    ) => Effect.Effect<void, StoreUnavailable>;
  }
>()("@fractalboxdev/flare-dispatch-intake/IntakeStore") {}

/**
 * `recordShed(scope_id, run, reason, estimated cost)` (MAMEKO-ADM-091): a request rejected before admission, written to
 * mameko's `shed` table with a null class.
 */
export class ShedRecorder extends Context.Service<
  ShedRecorder,
  { readonly record: (row: ShedRow) => Effect.Effect<void, StoreUnavailable> }
>()("@fractalboxdev/flare-dispatch-intake/ShedRecorder") {}

const query = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (e) => new StoreUnavailable({ message: String(e) }) });

interface Row {
  readonly execution_id: string;
  readonly trigger: string;
  readonly run: string;
  readonly label: string | null;
  readonly repo: string;
  readonly sha: string;
  readonly ref: string;
  readonly inputs_json: string;
  readonly class: string;
  readonly labels_json: string;
  readonly attempt: number;
  readonly family_root: string;
  readonly installation: number | null;
  readonly caller: string | null;
  readonly not_before: number | null;
  readonly spend_line: string | null;
  readonly placement_constraint: string | null;
  readonly cache_trigger_json: string | null;
  readonly eligible_kinds: string | null;
  readonly repository_public: number | null;
  readonly input_associations_json: string | null;
  readonly created_at: number;
  readonly status: string | null;
}

interface FactsRow {
  readonly run: string;
  readonly label: string | null;
  readonly sha: string;
  readonly attempt: number;
  readonly class: string;
  readonly status: string;
  readonly reason: string | null;
  readonly enqueued_at: number;
  readonly finished_at: number | null;
  readonly placed: number | null;
  readonly admitted_at: number | null;
  readonly claim_latency_ms: number | null;
  readonly leased_kind: string | null;
  readonly accepted_kind: string | null;
  readonly cloud_won: number | null;
  readonly reserved: number | null;
  readonly hold_micro_usd: number | null;
  readonly reservation_state: string | null;
  readonly metered_micro_usd: number | null;
}

const FACTS = `select r.run, r.label, r.sha, r.attempt, r.class, e.status, e.reason, e.enqueued_at, e.finished_at,
    p.execution_id is not null as placed, p.admitted_at, p.claim_latency_ms, p.leased_kind, p.accepted_kind, p.cloud_won,
    s.execution_id is not null as reserved, s.hold_micro_usd, s.state as reservation_state, s.metered_micro_usd
  from intake_records r
  join executions e on e.id = r.execution_id
  left join placements p on p.execution_id = r.execution_id
  left join reservations s on s.execution_id = r.execution_id
  where r.execution_id = ?`;

const factsOfRow = (f: FactsRow): ExecutionRecordFacts => ({
  name: checkName(f.run, f.label),
  headSha: f.sha,
  attempt: f.attempt,
  className: f.class,
  status: f.status,
  reason: f.reason,
  enqueuedAt: f.enqueued_at,
  finishedAt: f.finished_at,
  placement:
    f.placed === 1
      ? {
          admittedAt: f.admitted_at,
          claimLatencyMs: f.claim_latency_ms,
          leasedKind: f.leased_kind,
          acceptedKind: f.accepted_kind,
          cloudWon: f.cloud_won === null ? null : f.cloud_won === 1,
        }
      : null,
  reservation:
    f.reserved === 1
      ? {
          holdMicroUsd: f.hold_micro_usd ?? 0,
          state: f.reservation_state ?? "held",
          meteredMicroUsd: f.metered_micro_usd,
        }
      : null,
});

const decodeCacheTrigger = Schema.decodeUnknownOption(CacheTriggerRecord);

/** A row's cache trigger; a missing or unreadable one reads as `Other`, which restores protected tiers and writes none. */
const cacheTriggerOfRow = (json: string | null): CacheTriggerRecord => {
  if (json === null) return OTHER_CACHE_TRIGGER;
  try {
    return Option.getOrElse(decodeCacheTrigger(JSON.parse(json)), () => OTHER_CACHE_TRIGGER);
  } catch {
    return OTHER_CACHE_TRIGGER;
  }
};

const fromRow = (r: Row): RecordWithStatus => ({
  executionId: r.execution_id,
  trigger: r.trigger as RecordedTrigger,
  run: r.run,
  label: r.label,
  repo: r.repo,
  sha: r.sha,
  ref: r.ref,
  inputs: JSON.parse(r.inputs_json) as unknown,
  className: r.class,
  labels: JSON.parse(r.labels_json) as string[],
  attempt: r.attempt,
  familyRoot: r.family_root,
  installation: r.installation,
  caller: r.caller,
  notBefore: r.not_before,
  spendLine: r.spend_line,
  placementConstraint: r.placement_constraint,
  cacheTrigger: cacheTriggerOfRow(r.cache_trigger_json),
  eligibleKinds: r.eligible_kinds === null ? null : (JSON.parse(r.eligible_kinds) as string[]),
  repositoryPublic: r.repository_public === null ? null : r.repository_public === 1,
  inputAssociations:
    r.input_associations_json === null ? [] : (JSON.parse(r.input_associations_json) as string[]),
  createdAt: r.created_at,
  status: r.status,
});

const SELECT = `select r.*,
    coalesce(e.status, case when h.execution_id is not null then '${HELD_STATUS}' end) as status
  from intake_records r
  left join executions e on e.id = r.execution_id
  left join intake_held h on h.execution_id = r.execution_id`;

const RECORD_COLUMNS = `execution_id, trigger, run, label, repo, sha, ref, inputs_json,
  class, labels_json, attempt, family_root, installation, caller, not_before, spend_line,
  placement_constraint, cache_trigger_json, eligible_kinds, repository_public, input_associations_json,
  created_at`;

const recordValues = (r: IntakeRecord) =>
  [
    r.executionId,
    r.trigger,
    r.run,
    r.label,
    r.repo,
    r.sha,
    r.ref,
    JSON.stringify(r.inputs ?? null),
    r.className,
    JSON.stringify(r.labels),
    r.attempt,
    r.familyRoot,
    r.installation,
    r.caller,
    r.notBefore,
    r.spendLine,
    r.placementConstraint,
    JSON.stringify(r.cacheTrigger),
    r.eligibleKinds === null ? null : JSON.stringify(r.eligibleKinds),
    r.repositoryPublic === null ? null : r.repositoryPublic ? 1 : 0,
    JSON.stringify(r.inputAssociations),
    r.createdAt,
  ] as const;

const RECORD_PLACEHOLDERS = RECORD_COLUMNS.split(",")
  .map(() => "?")
  .join(", ");

export const d1IntakeStore = (db: D1Like) =>
  Layer.succeed(IntakeStore, {
    hold: (r, held) =>
      query(async () => {
        const { sha256, requestDigest } = held.admit.dedup;
        const known = `exists (select 1 from dedup_keys where sha256 = ?)`;
        // One batch, which D1 runs atomically: the held row goes in only while no admitted or held execution has the
        // key, and the record only when its held row did.
        const results = await db.batch([
          db
            .prepare(
              `insert or ignore into intake_held
                 (execution_id, sha256, request_digest, admit_json, cooldown_bucket, not_before)
               select ?, ?, ?, ?, ?, ? where not ${known}`,
            )
            .bind(
              r.executionId,
              sha256,
              requestDigest,
              JSON.stringify(held.admit),
              held.cooldownBucket,
              held.notBefore,
              sha256,
            ),
          db
            .prepare(
              `insert into intake_records (${RECORD_COLUMNS})
               select ${RECORD_PLACEHOLDERS} where exists (select 1 from intake_held where execution_id = ?)`,
            )
            .bind(...recordValues(r), r.executionId),
          db
            .prepare(
              `select execution_id, request_digest from dedup_keys where sha256 = ?
               union all
               select execution_id, request_digest from intake_held where sha256 = ?`,
            )
            .bind(sha256, sha256),
        ]);
        const key = results[2]?.results?.[0] as
          | { execution_id: string; request_digest: string | null }
          | undefined;
        return key === undefined || key.execution_id === r.executionId
          ? ({ _tag: "Held" } as const)
          : ({
              _tag: "Known",
              executionId: key.execution_id,
              requestDigest: key.request_digest,
            } as const);
      }),
    due: (now, limit) =>
      query(() =>
        db
          .prepare(
            `select admit_json, cooldown_bucket, not_before from intake_held
             where not_before <= ? order by not_before, execution_id limit ?`,
          )
          .bind(now, limit)
          .all(),
      ).pipe(
        Effect.map(({ results }) =>
          (results as { admit_json: string; cooldown_bucket: string; not_before: number }[]).map(
            (row) => ({
              admit: JSON.parse(row.admit_json) as IntakeAdmitInput,
              cooldownBucket: row.cooldown_bucket,
              notBefore: row.not_before,
            }),
          ),
        ),
      ),
    release: (id) =>
      query(() => db.prepare("delete from intake_held where execution_id = ?").bind(id).run()).pipe(
        Effect.asVoid,
      ),
    put: (r) =>
      query(() =>
        db
          .prepare(`insert into intake_records (${RECORD_COLUMNS}) values (${RECORD_PLACEHOLDERS})`)
          .bind(...recordValues(r))
          .run(),
      ).pipe(Effect.asVoid),
    placed: (id) =>
      query(() =>
        db
          .prepare(
            `update intake_records set eligible_kinds =
               coalesce((select eligible_kinds from placements where execution_id = ?), '[]')
             where execution_id = ?
             returning exists (select 1 from placements where execution_id = ?) as placed`,
          )
          .bind(id, id, id)
          .all(),
      ).pipe(
        Effect.map(({ results }) => (results[0] as { placed: number } | undefined)?.placed === 1),
      ),
    drop: (id) =>
      query(() =>
        db.prepare("delete from intake_records where execution_id = ?").bind(id).run(),
      ).pipe(Effect.asVoid),
    get: (id) =>
      query(() => db.prepare(`${SELECT} where r.execution_id = ?`).bind(id).all()).pipe(
        Effect.map(({ results }) => {
          const row = results[0] as Row | undefined;
          return row === undefined ? null : fromRow(row);
        }),
      ),
    conclusionFacts: (id) =>
      query(() => db.prepare(FACTS).bind(id).all()).pipe(
        Effect.map(({ results }) => {
          const row = results[0] as FactsRow | undefined;
          return row === undefined ? null : factsOfRow(row);
        }),
      ),
    family: (root) =>
      query(() =>
        db.prepare(`${SELECT} where r.family_root = ? order by r.attempt`).bind(root).all(),
      ).pipe(Effect.map(({ results }) => (results as Row[]).map(fromRow))),
    atCommit: (repo, sha) =>
      query(() =>
        db
          .prepare(`${SELECT} where r.repo = ? and r.sha = ? order by r.created_at`)
          .bind(repo, sha)
          .all(),
      ).pipe(Effect.map(({ results }) => (results as Row[]).map(fromRow))),
    liveSupersessionGroups: (repo, prefix) =>
      query(() =>
        db
          .prepare(
            `select distinct supersession_key as key from executions
             where scope_id = ? and status in ('pending', 'running')
               and substr(supersession_key, 1, length(?)) = ?
             order by supersession_key`,
          )
          .bind(repo, prefix, prefix)
          .all(),
      ).pipe(Effect.map(({ results }) => (results as { key: string }[]).map((r) => r.key))),
    familySpend: (root) =>
      query(() =>
        db
          .prepare(
            `select
               coalesce(sum(case when s.state = 'settled' then coalesce(s.metered_micro_usd, 0)
                                 when s.state in ('held', 'unresolved') then s.hold_micro_usd else 0 end), 0) as spent,
               (select hold_micro_usd from reservations where execution_id = ?) as first_hold
             from intake_records r join reservations s on s.execution_id = r.execution_id
             where r.family_root = ?`,
          )
          .bind(root, root)
          .all(),
      ).pipe(
        Effect.map(({ results }) => {
          const row = results[0] as { spent: number; first_hold: number | null } | undefined;
          return { spentMicroUsd: row?.spent ?? 0, firstHoldMicroUsd: row?.first_hold ?? null };
        }),
      ),
    cooldown: (bucket) =>
      query(() =>
        db
          .prepare("select execution_id, armed_at from intake_cooldowns where bucket = ?")
          .bind(bucket)
          .all(),
      ).pipe(
        Effect.map(({ results }) => {
          const row = results[0] as { execution_id: string; armed_at: number } | undefined;
          return row === undefined
            ? null
            : { executionId: row.execution_id, armedAt: row.armed_at };
        }),
      ),
    armCooldown: (bucket, executionId, at) =>
      query(() =>
        db
          .prepare(
            `insert into intake_cooldowns (bucket, execution_id, armed_at) values (?, ?, ?)
             on conflict (bucket) do update set execution_id = excluded.execution_id, armed_at = excluded.armed_at`,
          )
          .bind(bucket, executionId, at)
          .run(),
      ).pipe(Effect.asVoid),
    recordDelivery: (installation, at) =>
      query(() =>
        db
          .prepare(
            `insert into intake_deliveries (installation, verified_at) values (?, ?)
             on conflict (installation) do update set verified_at = max(verified_at, excluded.verified_at)`,
          )
          .bind(installation, at)
          .run(),
      ).pipe(Effect.asVoid),
    lastDelivery: (installation) =>
      query(() =>
        db
          .prepare("select verified_at from intake_deliveries where installation = ?")
          .bind(installation)
          .all(),
      ).pipe(
        Effect.map(
          ({ results }) => (results[0] as { verified_at: number } | undefined)?.verified_at ?? null,
        ),
      ),
    pullRequestClosed: (repo, number, at) =>
      query(() =>
        db
          .prepare(
            `insert into intake_pull_request_closes (repo, number, closed_at) values (?, ?, ?)
             on conflict (repo, number) do update set closed_at = excluded.closed_at`,
          )
          .bind(repo.toLowerCase(), number, at)
          .run(),
      ).pipe(Effect.asVoid),
    pullRequestReopened: (repo, number) =>
      query(() =>
        db
          .prepare("delete from intake_pull_request_closes where repo = ? and number = ?")
          .bind(repo.toLowerCase(), number)
          .run(),
      ).pipe(Effect.asVoid),
  });

/**
 * When pull request `number` of `repo` closed, epoch ms, as intake recorded the `pull_request` `closed` delivery; null
 * while it is open or intake saw no close. The cache sweep reads it for `pr/<repo>/<number>` (FD-CACHE-064).
 */
export const pullRequestClosedAt =
  (db: D1Like) =>
  async (repo: string, number: number): Promise<number | null> =>
    (
      (
        await db
          .prepare("select closed_at from intake_pull_request_closes where repo = ? and number = ?")
          .bind(repo.toLowerCase(), number)
          .all()
      ).results[0] as { readonly closed_at: number } | undefined
    )?.closed_at ?? null;

/**
 * A refusal that ends intake for a whole trigger, before any run is known, records a null run (MAMEKO-ADM-043); an
 * unestimated request records a cost of 0.
 */
export const d1ShedRecorder = (db: D1Like) =>
  Layer.succeed(ShedRecorder, {
    record: (row) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        recordShed(db, {
          scopeId: row.scopeId,
          run: row.run ?? null,
          reason: row.reason,
          estimatedCostMicroUsd: row.estimatedCost ?? 0,
          recordedAt: now,
        }),
      ).pipe(Effect.mapError((e) => new StoreUnavailable({ message: String(e.cause) }))),
  });
