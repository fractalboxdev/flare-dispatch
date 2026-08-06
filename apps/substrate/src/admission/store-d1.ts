// D1-backed admission semaphore (specs/adr/0004-admission-enforced-by-ticket.md).
//
// The same proven shape as the dispatcher's run-admission store
// (packages/runtime-cf/src/run-admission-d1.ts): D1 is single-threaded per
// database, so ONE conditional UPDATE is a real atomic claim — two racing
// claimers cannot both count under the cap. Per-pool counting semaphore with
// FIFO no-barge ordering, heartbeat decay on admitted rows (a crashed holder's
// slot frees itself), and a shorter waiter TTL so a dead waiter never blocks
// the line.
//
// Differences from the dispatcher's store, all contract-driven:
// - a `consumer` column, so poolStatus() answers per-consumer occupancy
//   (ADR-0009 needs consumer identity on every call) and refusals can be
//   attributed;
// - no parent-priority inheritance — matrix fan-out is a dispatcher concept
//   and stays consumer-side until its adoption;
// - plain promises, no Effect: the substrate's boundary speaks plain
//   structural types (ADR-0003), and its internals stay portable with the
//   ported engine.
//
// This D1 binding exists ONLY on the substrate worker — that exclusivity is
// the structural half of "one admission path" (ADR-0004).
import type { PoolName, PoolStatus } from "@fractalboxdev/flare-dispatch-substrate-contract";
import { POOLS, type PoolCaps } from "./pools";

/** Heartbeat staleness ceiling for ADMITTED rows — matches the ticket TTL. */
export const ADMISSION_TTL_MS = 10 * 60_000;

/** Heartbeat staleness ceiling for QUEUED rows (~5 poll cadences of silence). */
export const ADMISSION_WAITER_TTL_MS = 100_000;

export type AdmissionAttempt = {
  admitted: boolean;
  /** Live queued rows ahead (0 when admitted). */
  position: number;
  /** Live admitted rows in the pool. */
  poolBusy: number;
  now: number;
};

/** Retry one D1 statement twice on a transient error, then surface it. */
async function withRetry<A>(thunk: () => Promise<A>): Promise<A> {
  let lastError: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await thunk();
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export type AdmissionStore = {
  /** Idempotent enqueue; a replay gets the original `enqueued_at` back. */
  enqueue(id: string, consumer: string, pool: PoolName): Promise<{ enqueuedAt: number }>;
  /**
   * One claim attempt: re-entrant short-circuit for a row already admitted,
   * self-heal for a GC'd waiter, the atomic FIFO claim, then the observation.
   */
  attempt(id: string, consumer: string, pool: PoolName, cap: number): Promise<AdmissionAttempt>;
  /** Refresh the holder's heartbeat so a live slot is never reclaimed. */
  heartbeat(id: string): Promise<void>;
  /** Release the slot / leave the line (idempotent) + opportunistic corpse GC. */
  release(id: string): Promise<void>;
  /** Per-pool, per-consumer occupancy for poolStatus(). */
  status(caps: PoolCaps): Promise<PoolStatus>;
};

export const makeAdmissionStoreD1 = (
  db: D1Database,
  now: () => number = Date.now,
): AdmissionStore => {
  const insertQueued = (
    id: string,
    consumer: string,
    pool: PoolName,
    enqueuedAt: number | undefined,
    ts: number,
  ): Promise<unknown> =>
    withRetry(() =>
      db
        .prepare(
          `INSERT OR IGNORE INTO sub_admissions
             (execution_id, consumer, pool, state, enqueued_at, heartbeat_at)
           VALUES (?1, ?2, ?3, 'queued', COALESCE(?4, ?5), ?5)`,
        )
        .bind(id, consumer, pool, enqueuedAt ?? null, ts)
        .run(),
    );

  const enqueue = async (
    id: string,
    consumer: string,
    pool: PoolName,
  ): Promise<{ enqueuedAt: number }> => {
    const ts = now();
    await insertQueued(id, consumer, pool, undefined, ts);
    const row = await withRetry(() =>
      db
        .prepare(`SELECT enqueued_at FROM sub_admissions WHERE execution_id = ?`)
        .bind(id)
        .first<{ enqueued_at: number }>(),
    );
    return { enqueuedAt: row?.enqueued_at ?? ts };
  };

  const heartbeat = (id: string): Promise<void> =>
    withRetry(() =>
      db
        .prepare(`UPDATE sub_admissions SET heartbeat_at = ? WHERE execution_id = ?`)
        .bind(now(), id)
        .run(),
    ).then(() => undefined);

  const attempt = async (
    id: string,
    consumer: string,
    pool: PoolName,
    cap: number,
  ): Promise<AdmissionAttempt> => {
    const ts = now();
    const own = await withRetry(() =>
      db
        .prepare(`SELECT state, enqueued_at FROM sub_admissions WHERE execution_id = ?`)
        .bind(id)
        .first<{ state: string; enqueued_at: number }>(),
    );
    // Re-entrant short-circuit: a caller that died after its claim landed
    // replays with the row ALREADY admitted — the claim below (which flips
    // queued rows only) would never land again and the caller would starve
    // while holding a slot. Refresh + proceed instead.
    if (own?.state === "admitted") {
      await heartbeat(id);
      return { admitted: true, position: 0, poolBusy: 0, now: ts };
    }
    // Self-heal: a waiter GC'd by a peer's release re-inserts with its
    // original FIFO key, so the claim has a row to flip.
    if (own === null) await insertQueued(id, consumer, pool, undefined, ts);
    const enqueuedAt = own?.enqueued_at ?? ts;

    const claim = await withRetry(() =>
      db
        .prepare(
          `UPDATE sub_admissions SET state='admitted', admitted_at=?2, heartbeat_at=?2
           WHERE execution_id = ?1 AND state = 'queued'
             AND (SELECT COUNT(*) FROM sub_admissions
                   WHERE pool = ?3 AND state = 'admitted' AND heartbeat_at > ?4) < ?5
             AND NOT EXISTS (SELECT 1 FROM sub_admissions o
                   WHERE o.pool = ?3 AND o.state = 'queued'
                     AND o.heartbeat_at > ?6
                     AND (o.enqueued_at < ?7
                          OR (o.enqueued_at = ?7 AND o.execution_id < ?1)))`,
        )
        .bind(id, ts, pool, ts - ADMISSION_TTL_MS, cap, ts - ADMISSION_WAITER_TTL_MS, enqueuedAt)
        .run(),
    );
    if (claim.meta.changes === 1) return { admitted: true, position: 0, poolBusy: 0, now: ts };

    await heartbeat(id);
    const counts = await withRetry(() =>
      db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM sub_admissions
               WHERE pool = ?1 AND state = 'queued'
                 AND heartbeat_at > ?2
                 AND (enqueued_at < ?3
                      OR (enqueued_at = ?3 AND execution_id < ?4))) AS position,
             (SELECT COUNT(*) FROM sub_admissions
               WHERE pool = ?1 AND state = 'admitted'
                 AND heartbeat_at > ?5) AS busy`,
        )
        .bind(pool, now() - ADMISSION_WAITER_TTL_MS, enqueuedAt, id, now() - ADMISSION_TTL_MS)
        .first<{ position: number; busy: number }>(),
    );
    return {
      admitted: false,
      position: counts?.position ?? 0,
      poolBusy: counts?.busy ?? 0,
      now: ts,
    };
  };

  const release = (id: string): Promise<void> =>
    withRetry(() =>
      db.batch([
        db.prepare(`DELETE FROM sub_admissions WHERE execution_id = ?`).bind(id),
        // Opportunistic GC: stale rows already stopped counting; this keeps
        // the table from accumulating corpses. No cron sweeper needed.
        db
          .prepare(`DELETE FROM sub_admissions WHERE heartbeat_at < ?`)
          .bind(now() - ADMISSION_TTL_MS),
      ]),
    ).then(() => undefined);

  const status = async (caps: PoolCaps): Promise<PoolStatus> => {
    const ts = now();
    const rows = await withRetry(() =>
      db
        .prepare(
          `SELECT pool, consumer, state, COUNT(*) AS n FROM sub_admissions
            WHERE (state = 'admitted' AND heartbeat_at > ?1)
               OR (state = 'queued'   AND heartbeat_at > ?2)
            GROUP BY pool, consumer, state`,
        )
        .bind(ts - ADMISSION_TTL_MS, ts - ADMISSION_WAITER_TTL_MS)
        .all<{ pool: string; consumer: string; state: string; n: number }>(),
    );
    return {
      pools: POOLS.map((pool) => {
        const mine = rows.results.filter((r) => r.pool === pool);
        const byConsumer: Record<string, number> = {};
        for (const r of mine.filter((r) => r.state === "admitted"))
          byConsumer[r.consumer] = (byConsumer[r.consumer] ?? 0) + r.n;
        return {
          pool,
          cap: caps[pool],
          busy: mine.filter((r) => r.state === "admitted").reduce((a, r) => a + r.n, 0),
          queued: mine.filter((r) => r.state === "queued").reduce((a, r) => a + r.n, 0),
          byConsumer,
        };
      }),
    };
  };

  return { enqueue, attempt, heartbeat, release, status };
};
