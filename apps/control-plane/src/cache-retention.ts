// The cache area's minute-tick steps: the ledger-end step that releases an ended execution's unused reservations, and
// the cache, artifact and log retention sweeps. It imports nothing from the Workers runtime, so it runs outside it.
import {
  ARTIFACT_SCHEMA,
  ledgersOf,
  sweepArtifacts,
  sweepCache,
  sweepLogs,
  type CacheLedgers,
} from "@fractalboxdev/flare-dispatch-cache";
import type { TickStep } from "@fractalboxdev/flare-dispatch-ops";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect, Schema } from "effect";
import type { CacheEnv } from "./cache.ts";
import type { ControlPlaneEnv } from "./config.ts";

/** The test an execution's status passes once it is terminal, as mameko's parent-ended cascade reads it. */
const TERMINAL = "status not in ('pending', 'running')";

/**
 * The executions whose reservations the ledger-end step released (FD-CACHE-055), kept for the lookback so a repeat
 * pass calls no `CacheLedger` twice for one execution.
 */
export const LEDGER_END_SCHEMA = [
  `create table if not exists cache_ledger_ended (
    execution_id text primary key,
    finished_at integer not null)`,
  `create index if not exists cache_ledger_ended_finished on cache_ledger_ended (finished_at)`,
];

const migrated = new WeakMap<D1Like, Promise<unknown>>();

/** The artifact rows' table (FD-CACHE-073) and the ledger-end step's record of ended executions. */
export const migrateCache = (db: D1Like) => {
  const existing = migrated.get(db);
  if (existing !== undefined) return existing;
  const run = (async () => {
    for (const sql of [...ARTIFACT_SCHEMA, ...LEDGER_END_SCHEMA]) await db.prepare(sql).run();
  })().catch((e: unknown) => {
    migrated.delete(db);
    throw e;
  });
  migrated.set(db, run);
  return run;
};

/** A `CacheLedger` call for an ended execution failed; the execution stays unrecorded and the next pass retries it. */
export class LedgerEndFailed extends Schema.TaggedError<LedgerEndFailed>()("LedgerEndFailed", {
  executionId: Schema.String,
  message: Schema.String,
}) {}

/** How far back the ledger-end step looks for ended executions: a pass that fails is retried for 7 days. */
export const LEDGER_END_LOOKBACK_MS = 7 * 24 * 3600 * 1000;

/** At most this many `CacheLedger` calls per pass; the rest wait for the next minute. */
export const LEDGER_END_BATCH = 100;

/**
 * Every execution that reached a terminal status in the lookback and whose ledger the step has not ended, oldest end
 * first. Only an execution intake recorded has a repository, and so a ledger to hold its reservations.
 */
const NEWLY_TERMINAL = `select e.id, r.repo, e.deadline_at, e.finished_at from executions e
  join intake_records r on r.execution_id = e.id
  where e.finished_at >= ? and e.${TERMINAL}
    and not exists (select 1 from cache_ledger_ended d where d.execution_id = e.id)
  order by e.finished_at, e.id
  limit ${LEDGER_END_BATCH}`;

interface EndedRow {
  readonly id: string;
  readonly repo: string;
  readonly deadline_at: number | null;
  readonly finished_at: number;
}

/**
 * One pass of the ledger-end step (FD-CACHE-055): each execution that reached a terminal status gets one
 * `CacheLedger.end` call in its repository's ledger, which releases its unused reservations and refuses its later
 * ones. The ledger may forget the execution's record after its `deadline_at`, or after its end when it has none.
 */
export const releaseEndedReservations = (db: D1Like, ledgers: CacheLedgers, now: number) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => migrateCache(db));
    const since = now - LEDGER_END_LOOKBACK_MS;
    yield* Effect.promise(() =>
      db.prepare(`delete from cache_ledger_ended where finished_at < ?`).bind(since).run(),
    );
    const { results } = yield* Effect.promise(() => db.prepare(NEWLY_TERMINAL).bind(since).all());
    const outcomes = yield* Effect.forEach(results as readonly EndedRow[], (row) =>
      Effect.tryPromise({
        try: async () => {
          await ledgers(row.repo).end({
            executionId: row.id,
            expiresAt: Math.max(row.deadline_at ?? row.finished_at, row.finished_at),
          });
          await db
            .prepare(
              `insert into cache_ledger_ended (execution_id, finished_at) values (?, ?)
               on conflict (execution_id) do nothing`,
            )
            .bind(row.id, row.finished_at)
            .run();
        },
        catch: (e) => new LedgerEndFailed({ executionId: row.id, message: String(e) }),
      }).pipe(
        Effect.as(true),
        Effect.catchTag("LedgerEndFailed", (e) =>
          Effect.logWarning("cache.ledger_end_failed", e.executionId, e.message).pipe(
            Effect.as(false),
          ),
        ),
      ),
    );
    const ended = outcomes.filter((ok) => ok).length;
    return { ended, failed: outcomes.length - ended };
  });

/**
 * When an execution ended, from mameko's `executions.finished_at`, which every terminal transition writes; `null` while
 * it is `pending` or `running`. The log sweep's retention counts from it (FD-CACHE-089).
 */
export const executionEndedAt =
  (db: D1Like) =>
  async (id: string): Promise<number | null> =>
    (
      (
        await db
          .prepare(`select finished_at as at from executions where id = ? and ${TERMINAL}`)
          .bind(id)
          .all()
      ).results[0] as { readonly at: number | null } | undefined
    )?.at ?? null;

/**
 * The ledger-end step and the retention sweeps (FD-CACHE-055, FD-CACHE-062 to FD-CACHE-066, FD-CACHE-079,
 * FD-CACHE-089). No GitHub read answers when a pull request closed, so a pull-request namespace ages out by its TTL
 * alone.
 */
export const cacheSweeps =
  (env: ControlPlaneEnv & CacheEnv) =>
  (now: number): readonly TickStep[] => {
    const bucket = env.CACHE;
    const ledger = env.CACHE_LEDGER;
    if (bucket === undefined || ledger === undefined) return [];
    const ledgers = ledgersOf(ledger);
    return [
      {
        step: "ledger-end",
        effect: releaseEndedReservations(env.DB, ledgers, now),
      },
      {
        step: "cache-sweep",
        effect: Effect.promise(() =>
          sweepCache(bucket, now, {
            ledgers,
            pullRequestClosedAt: async () => null,
          }),
        ),
      },
      {
        step: "artifact-sweep",
        effect: Effect.promise(async () => {
          await migrateCache(env.DB);
          return sweepArtifacts(env.DB as unknown as D1Database, bucket, now);
        }),
      },
      {
        step: "log-sweep",
        effect: Effect.promise(() => sweepLogs(bucket, executionEndedAt(env.DB), now)),
      },
    ];
  };
