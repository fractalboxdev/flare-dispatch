// @fractalbox/flare-dispatch-runtime-cf — D1-backed container lease.
//
// Serializes runs that share a sandbox container id so they never execute
// concurrently in one container (the contention the demo runs hit: two runs for
// the same repo+sha normalise to the SAME `demo-<owner>-<repo>-<sha12>` sandbox
// id, route to the same Durable Object, and interleave exec + Browser Rendering
// sessions). The lease is acquired in `makeSandboxCloudflareLive.acquire` —
// the first container RPC, hence the natural lease point — and released at the
// Workflow's finalize boundary.
//
// D1 is the lease store, not KV: D1 is strongly consistent and supports an
// ATOMIC conditional upsert, so two racing acquirers cannot both win. KV is
// eventually consistent with no compare-and-set, which would let both demo runs
// believe they hold the lease — defeating the purpose. The `executions` D1
// binding is already threaded through the runtime, so this adds one table, no
// new binding.
//
// The PURE decision (acquire / wait / reclaim a stale lease) lives in
// `@fractalbox/flare-dispatch-core` `container-lease.ts` and is unit-tested there; this
// module is the I/O shell — the atomic SQL + the bounded poll loop. Container
// boot cannot run under `vitest-pool-workers`, but the loop's termination is
// governed by the pure `leaseAcquireAttempts` count (tested), so the untestable
// surface here is just the SQL binding.
//
// Spec: specs/03-dsl.md § sandbox.

import { Duration, Effect, Schedule } from "effect";
import {
  ContainerBusy,
  decideLease,
  type LeaseRecord,
  leaseAcquireAttempts,
} from "@fractalbox/flare-dispatch-core";

/**
 * Heartbeat staleness ceiling. A lease whose last heartbeat is older than this
 * is presumed dead (the holding Worker was evicted mid-run / the run crashed)
 * and may be reclaimed — without this a single crashed run would wedge a
 * container id forever. Must comfortably exceed both the poll interval and the
 * heartbeat cadence so a live-but-busy holder is never mistaken for dead. A demo
 * run's slowest single step (cold `pnpm install` + `playwright install`) is a
 * few minutes; 10 minutes leaves ample margin.
 */
export const LEASE_TTL_MS = 10 * 60_000;

/** Delay between acquire-poll attempts while a peer holds the lease. */
export const LEASE_POLL_EVERY_MS = 5_000;

/**
 * Cadence the HOLDER refreshes its heartbeat while it works, so the lease is
 * never reclaimed mid-run. A run can outlive {@link LEASE_TTL_MS} (a 25-min
 * `cdp-acceptance` matrix), so the holder must keep the heartbeat fresh.
 * TTL/4 leaves three missed beats of slack before a live holder is mistaken for
 * dead, while keeping the D1 write rate modest (~10 writes over a long run).
 */
export const LEASE_HEARTBEAT_EVERY_MS = LEASE_TTL_MS / 4;

/**
 * Overall ceiling a queued run waits for a busy peer before failing
 * `ContainerBusy`. A peer demo run finishes in minutes; 10 minutes covers a
 * legitimately slow predecessor without hanging until the Workflow wall-clock
 * cap. Equal to the TTL by design: once the wait exceeds the TTL, a still-held
 * lease is either genuinely alive (a very slow peer — fail loud) or its holder
 * died and the NEXT poll would reclaim it; either way 10 minutes is the right
 * give-up point.
 */
export const LEASE_WAIT_TIMEOUT_MS = 10 * 60_000;

/** The D1 row shape, snake_case as stored. */
interface LeaseRow {
  readonly container_id: string;
  readonly holder: string;
  readonly acquired_at: number;
  readonly heartbeat_at: number;
}

const toRecord = (row: LeaseRow): LeaseRecord => ({
  containerId: row.container_id,
  holder: row.holder,
  acquiredAt: row.acquired_at,
  heartbeatAt: row.heartbeat_at,
});

/**
 * One D1 statement, retried twice on a transient error then surfaced. A lease
 * read/write is a single fast query; a flaky D1 call should not collapse the
 * whole acquire.
 */
const d1 = <A>(thunk: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  }).pipe(
    Effect.retry(
      Schedule.recurs(2).pipe(Schedule.addDelay(() => "200 millis")),
    ),
  );

/** A handle the caller uses to heartbeat / release the lease it acquired. */
export interface LeaseHandle {
  readonly containerId: string;
  readonly holder: string;
  /** Refresh the heartbeat so the lease is not reclaimed as stale. */
  readonly heartbeat: () => Effect.Effect<void, Error>;
  /** Release the lease (only if WE still hold it). Idempotent. */
  readonly release: () => Effect.Effect<void, Error>;
}

export interface ContainerLeaseStore {
  /**
   * Block until this `holder` holds the lease for `containerId`, then return a
   * handle. Polls a busy peer up to {@link LEASE_WAIT_TIMEOUT_MS}; fails
   * `ContainerBusy` if the peer never releases in time. Re-entrant: a holder
   * that already owns the lease returns immediately.
   */
  readonly acquire: (
    containerId: string,
    holder: string,
  ) => Effect.Effect<LeaseHandle, ContainerBusy>;
}

/**
 * Build a D1-backed container lease store. `now` is injectable so tests can
 * drive the clock; production passes `Date.now`.
 */
export const makeContainerLeaseD1 = (
  db: D1Database,
  now: () => number = Date.now,
): ContainerLeaseStore => {
  const readLease = (
    containerId: string,
  ): Effect.Effect<LeaseRecord | undefined, Error> =>
    d1(() =>
      db
        .prepare(
          `SELECT container_id, holder, acquired_at, heartbeat_at
             FROM container_leases WHERE container_id = ?`,
        )
        .bind(containerId)
        .first<LeaseRow>(),
    ).pipe(Effect.map((row) => (row === null ? undefined : toRecord(row))));

  /**
   * Atomic conditional upsert: insert the lease, or overwrite an existing one
   * ONLY when it is ours (re-entrant heartbeat refresh) or stale (the prior
   * holder's heartbeat predates `now - ttl`). The `WHERE` on the `DO UPDATE`
   * makes the steal conditional inside one statement, so two racing acquirers
   * cannot both succeed — D1 serializes the writes and the loser's `WHERE` sees
   * the winner's fresh row. Returns whether WE hold the lease afterwards.
   */
  const tryClaim = (
    containerId: string,
    holder: string,
    ts: number,
  ): Effect.Effect<boolean, Error> =>
    d1(() =>
      db
        .prepare(
          `INSERT INTO container_leases (container_id, holder, acquired_at, heartbeat_at)
             VALUES (?1, ?2, ?3, ?3)
           ON CONFLICT(container_id) DO UPDATE SET
             holder = ?2,
             acquired_at = ?3,
             heartbeat_at = ?3
           WHERE container_leases.holder = ?2
              OR container_leases.heartbeat_at <= ?4`,
        )
        // ?4 = the staleness cutoff: any lease whose heartbeat is at/below it is
        // reclaimable. `now - ttl` matches the pure `isLeaseStale` boundary.
        .bind(containerId, holder, ts, ts - LEASE_TTL_MS)
        .run(),
    ).pipe(
      // The upsert is advisory; confirm by reading back who holds it now. A
      // contended steal where our `WHERE` failed leaves the peer's row intact.
      Effect.flatMap(() => readLease(containerId)),
      Effect.map((lease) => lease !== undefined && lease.holder === holder),
    );

  const heartbeat = (
    containerId: string,
    holder: string,
  ): Effect.Effect<void, Error> =>
    d1(() =>
      db
        .prepare(
          `UPDATE container_leases SET heartbeat_at = ?
             WHERE container_id = ? AND holder = ?`,
        )
        .bind(now(), containerId, holder)
        .run(),
    ).pipe(Effect.asVoid);

  const release = (
    containerId: string,
    holder: string,
  ): Effect.Effect<void, Error> =>
    d1(() =>
      db
        .prepare(
          `DELETE FROM container_leases WHERE container_id = ? AND holder = ?`,
        )
        .bind(containerId, holder)
        .run(),
    ).pipe(Effect.asVoid);

  const makeHandle = (containerId: string, holder: string): LeaseHandle => ({
    containerId,
    holder,
    heartbeat: () => heartbeat(containerId, holder),
    release: () => release(containerId, holder),
  });

  const acquire = (
    containerId: string,
    holder: string,
  ): Effect.Effect<LeaseHandle, ContainerBusy> =>
    Effect.gen(function* () {
      const startedAt = now();
      const maxAttempts = leaseAcquireAttempts(
        LEASE_WAIT_TIMEOUT_MS,
        LEASE_POLL_EVERY_MS,
      );

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const ts = now();
        const current = yield* readLease(containerId);
        const decision = decideLease(current, holder, ts, LEASE_TTL_MS);

        // `held` (re-entrant) → refresh heartbeat + proceed. `acquire` /
        // `reclaim` → attempt the conditional upsert; on success, proceed.
        if (decision._kind === "held") {
          yield* heartbeat(containerId, holder);
          return makeHandle(containerId, holder);
        }
        if (decision._kind === "acquire" || decision._kind === "reclaim") {
          const won = yield* tryClaim(containerId, holder, ts);
          if (won) return makeHandle(containerId, holder);
          // Lost a race to another acquirer — fall through to wait + retry.
        }

        // `wait` (or a lost claim race): poll again unless the ceiling is hit.
        if (attempt < maxAttempts - 1) {
          yield* Effect.sleep(Duration.millis(LEASE_POLL_EVERY_MS));
        } else {
          const holderNow =
            (yield* readLease(containerId))?.holder ?? "unknown";
          return yield* Effect.fail(
            new ContainerBusy({
              containerId,
              holder: holderNow,
              waitedMs: now() - startedAt,
            }),
          );
        }
      }
      // Unreachable — the final attempt returns or fails above.
      return yield* Effect.fail(
        new ContainerBusy({
          containerId,
          holder: "unknown",
          waitedMs: now() - startedAt,
        }),
      );
    }).pipe(
      // A D1 read/write that fails even after the in-helper retries is genuine
      // infra breakage, not a run-level outcome — die so it surfaces as a
      // defect, leaving the public error channel a clean `ContainerBusy`. A
      // `ContainerBusy` (the wait ceiling elapsed) stays in the error channel.
      Effect.catchAll((e) =>
        e instanceof ContainerBusy ? Effect.fail(e) : Effect.die(e),
      ),
    );

  return { acquire };
};
