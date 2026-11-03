// FlareDispatch's own intake tables on D1. mameko's admission stores no inputs,
// trigger, attempt or check label (host-cloudflare d1.ts `admitExecution`), and
// a lease, a check re-run and a cancel all need them, so intake keeps one row
// per execution beside mameko's. Shed rows, cooldown windows and webhook delivery
// times live here too.
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { CacheTriggerRecord, OTHER_CACHE_TRIGGER, type RecordedTrigger } from "./event.ts";

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
    deadline_at integer not null,
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
    created_at integer not null)`,
  `create index if not exists intake_records_family on intake_records (family_root)`,
  `create index if not exists intake_records_commit on intake_records (repo, sha)`,
  // mameko's admission batch inserts the placement row and takes no eligible kinds, so this trigger copies the kinds
  // the profile's placement gave the request into that row inside the same batch, before any executor can claim it
  // (FD-GATE-061, FD-GATE-080). intake writes its record before admission, so the record is there to read.
  `create trigger if not exists intake_placement_kinds after insert on placements
    when exists (select 1 from intake_records where execution_id = new.execution_id and eligible_kinds is not null)
    begin
      update placements set eligible_kinds =
        (select eligible_kinds from intake_records where execution_id = new.execution_id)
      where execution_id = new.execution_id;
    end`,
  `create table if not exists intake_shed (
    id integer primary key autoincrement,
    scope_id text not null,
    run text,
    reason text not null,
    estimated_cost integer,
    at integer not null)`,
  `create table if not exists intake_cooldowns (
    bucket text primary key,
    execution_id text not null,
    armed_at integer not null)`,
  `create table if not exists intake_deliveries (
    installation integer primary key,
    verified_at integer not null)`,
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
  readonly deadlineAtMs: number;
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
  /** The executor kinds the profile's placement allows; admission copies them into the placement row. */
  readonly eligibleKinds: readonly string[] | null;
  readonly createdAt: number;
}

/** A record with mameko's status of its execution; null when admission kept no execution for it. */
export interface RecordWithStatus extends IntakeRecord {
  readonly status: string | null;
}

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
    /** Removes the row of an id admission did not keep. */
    readonly drop: (executionId: string) => Effect.Effect<void, StoreUnavailable>;
    readonly get: (executionId: string) => Effect.Effect<RecordWithStatus | null, StoreUnavailable>;
    readonly family: (root: string) => Effect.Effect<readonly RecordWithStatus[], StoreUnavailable>;
    readonly atCommit: (
      repo: string,
      sha: string,
    ) => Effect.Effect<readonly RecordWithStatus[], StoreUnavailable>;
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
  }
>()("@fractalboxdev/flare-dispatch-intake/IntakeStore") {}

/**
 * `recordShed(scope_id, run, reason, estimated cost)` (MAMEKO-ADM-086): a request rejected before admission. mameko's
 * host adapter exposes no such function, so FlareDispatch's table holds the rows.
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
  readonly deadline_at: number;
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
  readonly created_at: number;
  readonly status: string | null;
}

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
  deadlineAtMs: r.deadline_at,
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
  createdAt: r.created_at,
  status: r.status,
});

const SELECT = `select r.*, e.status as status from intake_records r left join executions e on e.id = r.execution_id`;

export const d1IntakeStore = (db: D1Like) =>
  Layer.succeed(IntakeStore, {
    put: (r) =>
      query(() =>
        db
          .prepare(
            `insert into intake_records (execution_id, trigger, run, label, repo, sha, ref, inputs_json, deadline_at,
              class, labels_json, attempt, family_root, installation, caller, not_before, spend_line,
              placement_constraint, cache_trigger_json, eligible_kinds, created_at)
              values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            r.executionId,
            r.trigger,
            r.run,
            r.label,
            r.repo,
            r.sha,
            r.ref,
            JSON.stringify(r.inputs ?? null),
            r.deadlineAtMs,
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
            r.createdAt,
          )
          .run(),
      ).pipe(Effect.asVoid),
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
  });

export const d1ShedRecorder = (db: D1Like) =>
  Layer.succeed(ShedRecorder, {
    record: (row) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        query(() =>
          db
            .prepare(
              "insert into intake_shed (scope_id, run, reason, estimated_cost, at) values (?, ?, ?, ?, ?)",
            )
            .bind(row.scopeId, row.run, row.reason, row.estimatedCost, now)
            .run(),
        ),
      ).pipe(Effect.asVoid),
  });
