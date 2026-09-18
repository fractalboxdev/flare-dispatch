// @fractalboxdev/flare-dispatch-runtime-cf — D1-backed serial queue for runs that declare `serialize`.
//
// Executions that share a `SerializeSpec.group` never overlap. One holds the
// group ('running'); a newer dispatch waits ('queued'), and marks every OLDER
// waiter of its group 'superseded' in the same D1 batch that inserts it — so
// at any moment a group has at most one live waiter, the most recently
// dispatched. A superseded waiter concludes `RunSkipped` naming the revision
// that replaced it. The UPDATE that supersedes matches `state = 'queued'` only:
// a running execution is never cancelled, skipped, or otherwise touched by a
// newer one.
//
// `worker-deploy` is the reason this exists. Every default-branch push
// dispatches one; two pushes close together otherwise run as two concurrent
// executions, and the older commit can finish last and leave production on it.
//
// D1, not KV, for the reason `run-admission-d1.ts` gives: D1 serializes writes
// per database, so the conditional claim UPDATE is atomic and two waiters
// cannot both take a group. KV has no compare-and-set. Same `RUNS_METADATA`
// binding, one new table (migration 0007), no new binding.
//
// Order is ARRIVAL order (`enqueued_at`), not commit order: the dispatcher sees
// no commit graph. A dispatch of an older commit that arrives after a newer one
// — a re-requested check suite, a delayed webhook — supersedes the newer
// waiter. `worker-deploy`'s head check then skips the older commit too, and the
// branch head stays undeployed until the next dispatch. Both checks read
// `neutral` and name the other revision, so the gap is visible.
//
// The poll loop runs through the caller's durable steps (`stepDo` / `sleep`),
// exactly like the admission gate, so a waiter hibernates for free and a
// replay re-reads every checkpointed observation.

import { Effect, Schedule } from "effect";
import { RunSkipped, SerialQueueTimedOut } from "@fractalboxdev/flare-dispatch-core";
import { LEASE_TTL_MS } from "./container-lease-d1";

/** Delay between claim attempts while the group is held. */
export const SERIAL_POLL_EVERY_MS = 30_000;

/**
 * How long a waiter queues before failing `SerialQueueTimedOut`. Covers a
 * holder's full admission wait (20 min) plus a long deploy (25 min) with
 * headroom; 120 claims + 120 sleeps at the poll interval.
 */
export const SERIAL_MAX_WAIT_MS = 60 * 60_000;

/**
 * A 'running' row whose heartbeat is older than this stops blocking its group
 * — the holder was evicted or crashed. Shared with the container lease: the
 * same heartbeat cadence (`LEASE_HEARTBEAT_EVERY_MS`) refreshes both.
 */
export const SERIAL_HOLDER_TTL_MS = LEASE_TTL_MS;

/**
 * Rows of any state whose heartbeat is older than this are deleted by the
 * next release. Far above both TTLs and the max wait, so a live waiter's row —
 * refreshed every poll — is never collected under it.
 */
const SERIAL_GC_AFTER_MS = 6 * 60 * 60_000;

/** What one claim attempt observed. */
export type SerialObservation =
  | { readonly kind: "run" }
  | { readonly kind: "superseded"; readonly by: string }
  | { readonly kind: "wait"; readonly holderRevision: string | undefined };

/** What the waiter does next. */
export type SerialDecision =
  | { readonly kind: "run" }
  | { readonly kind: "superseded"; readonly by: string }
  | { readonly kind: "wait"; readonly holderRevision: string | undefined }
  | { readonly kind: "timeout"; readonly holderRevision: string | undefined; waitedMs: number };

/**
 * Pure: `run` and `superseded` are final whenever observed — a claim taken at
 * the deadline is kept; `wait` past `maxWaitMs` becomes `timeout`.
 */
export const decideSerial = (
  observed: SerialObservation,
  enqueuedAt: number,
  now: number,
  maxWaitMs: number,
): SerialDecision => {
  if (observed.kind !== "wait") return observed;
  const waitedMs = Math.max(0, now - enqueuedAt);
  return waitedMs >= maxWaitMs
    ? { kind: "timeout", holderRevision: observed.holderRevision, waitedMs }
    : observed;
};

/** One D1 call, retried twice on a transient error — `run-admission-d1.ts`'s shape. */
const d1 = <A>(thunk: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.retry(Schedule.recurs(2).pipe(Schedule.addDelay(() => "200 millis"))));

export interface SerialQueueStore {
  /**
   * Join the group's queue and supersede every older waiter in it, in one
   * batch. Idempotent (`INSERT OR IGNORE`): a replay returns the original
   * `enqueued_at` and supersedes only rows older than it, never a newer one.
   */
  readonly enqueue: (
    executionId: string,
    group: string,
    revision: string,
  ) => Effect.Effect<{ readonly enqueuedAt: number }, Error>;

  /**
   * One claim attempt. Takes the group when no live holder has it; otherwise
   * refreshes this waiter's heartbeat and reports the holder's revision, or
   * that a newer dispatch superseded this one. `now` is the clock the
   * observation was taken at, for `decideSerial`.
   */
  readonly attempt: (
    executionId: string,
    group: string,
    revision: string,
  ) => Effect.Effect<SerialObservation & { readonly now: number }, Error>;

  /** Refresh the holder's heartbeat so the group is not reclaimed mid-run. */
  readonly heartbeat: (executionId: string) => Effect.Effect<void, Error>;

  /** Delete this execution's row (idempotent) and collect long-stale rows. */
  readonly release: (executionId: string) => Effect.Effect<void, Error>;
}

/** Build the D1 store. `now` is injectable for tests; production passes `Date.now`. */
export const makeSerialQueueD1 = (
  db: D1Database,
  now: () => number = Date.now,
): SerialQueueStore => {
  const enqueueAt = (
    executionId: string,
    group: string,
    revision: string,
    ts: number,
  ): Effect.Effect<{ readonly enqueuedAt: number }, Error> =>
    d1(() =>
      db.batch([
        db
          .prepare(
            `INSERT OR IGNORE INTO serial_queue
               (execution_id, group_key, revision, state, enqueued_at, heartbeat_at)
             VALUES (?1, ?2, ?3, 'queued', ?4, ?4)`,
          )
          .bind(executionId, group, revision, ts),
        // Supersede strictly OLDER waiters, measured against OUR stored
        // `enqueued_at` — on a replay that is the original timestamp, so a
        // waiter that arrived after us is never superseded by our replay.
        // `state = 'queued'` is the whole never-cancel-in-flight guarantee.
        db
          .prepare(
            `UPDATE serial_queue SET state = 'superseded', superseded_by = ?3
             WHERE group_key = ?2 AND state = 'queued' AND execution_id != ?1
               AND (enqueued_at < (SELECT enqueued_at FROM serial_queue WHERE execution_id = ?1)
                    OR (enqueued_at = (SELECT enqueued_at FROM serial_queue WHERE execution_id = ?1)
                        AND execution_id < ?1))`,
          )
          .bind(executionId, group, revision),
        db.prepare(`SELECT enqueued_at FROM serial_queue WHERE execution_id = ?`).bind(executionId),
      ]),
    ).pipe(
      Effect.map((results) => {
        const row = results[2]?.results[0] as { enqueued_at: number } | undefined;
        return { enqueuedAt: row?.enqueued_at ?? ts };
      }),
    );

  const heartbeat = (executionId: string): Effect.Effect<void, Error> =>
    d1(() =>
      db
        .prepare(`UPDATE serial_queue SET heartbeat_at = ? WHERE execution_id = ?`)
        .bind(now(), executionId)
        .run(),
    ).pipe(Effect.asVoid);

  const attempt = (
    executionId: string,
    group: string,
    revision: string,
  ): Effect.Effect<SerialObservation & { readonly now: number }, Error> =>
    Effect.gen(function* () {
      const ts = now();
      const own = yield* d1(() =>
        db
          .prepare(`SELECT state, superseded_by FROM serial_queue WHERE execution_id = ?`)
          .bind(executionId)
          .first<{ state: string; superseded_by: string | null }>(),
      );
      if (own?.state === "superseded") {
        return { kind: "superseded" as const, by: own.superseded_by ?? "", now: ts };
      }
      // Re-entrant: the claim landed but the step did not checkpoint before
      // the Worker died. The row is already ours.
      if (own?.state === "running") {
        yield* heartbeat(executionId);
        return { kind: "run" as const, now: ts };
      }
      // A row collected under `SERIAL_GC_AFTER_MS` (a waiter paused for hours)
      // re-joins as the newest arrival rather than claiming blind.
      if (own === null) yield* enqueueAt(executionId, group, revision, ts);

      const claimed = yield* d1(() =>
        db
          .prepare(
            `UPDATE serial_queue SET state = 'running', heartbeat_at = ?2
             WHERE execution_id = ?1 AND state = 'queued'
               AND NOT EXISTS (SELECT 1 FROM serial_queue o
                     WHERE o.group_key = ?3 AND o.state = 'running' AND o.heartbeat_at > ?4)`,
          )
          .bind(executionId, ts, group, ts - SERIAL_HOLDER_TTL_MS)
          .run(),
      ).pipe(Effect.map((r) => r.meta.changes === 1));
      if (claimed) return { kind: "run" as const, now: ts };

      yield* heartbeat(executionId);
      const holder = yield* d1(() =>
        db
          .prepare(
            `SELECT revision FROM serial_queue
             WHERE group_key = ? AND state = 'running' AND heartbeat_at > ?
             ORDER BY heartbeat_at DESC LIMIT 1`,
          )
          .bind(group, ts - SERIAL_HOLDER_TTL_MS)
          .first<{ revision: string }>(),
      );
      return { kind: "wait" as const, holderRevision: holder?.revision, now: ts };
    });

  const release = (executionId: string): Effect.Effect<void, Error> =>
    d1(() =>
      db.batch([
        db.prepare(`DELETE FROM serial_queue WHERE execution_id = ?`).bind(executionId),
        db
          .prepare(`DELETE FROM serial_queue WHERE heartbeat_at < ?`)
          .bind(now() - SERIAL_GC_AFTER_MS),
      ]),
    ).pipe(Effect.asVoid);

  return {
    enqueue: (executionId, group, revision) => enqueueAt(executionId, group, revision, now()),
    attempt,
    heartbeat,
    release,
  };
};

/** The first 12 characters — how a check-run summary names a commit. */
const short = (revision: string): string => revision.slice(0, 12);

/**
 * The gate a serialized execution passes before admission. Succeeds once this
 * execution holds its group; fails `RunSkipped` when a newer dispatch replaced
 * it, and `SerialQueueTimedOut` past `maxWaitMs`. The caller heartbeats the
 * held row for the rest of the run and releases it on every exit path —
 * including a skip, whose row is then deleted.
 *
 * `stepDo` and `sleep` are the caller's durable Workflow steps: every clock
 * read and claim is checkpointed, so a replay re-decides on the same inputs.
 */
export const runSerialGate = (opts: {
  readonly store: SerialQueueStore;
  readonly executionId: string;
  readonly group: string;
  readonly revision: string;
  readonly stepDo: <T>(name: string, body: () => Promise<T>) => Effect.Effect<T>;
  readonly sleep: (name: string, ms: number) => Effect.Effect<void>;
  /** Called when the holder changes while waiting — best-effort reporting. */
  readonly onWait?: (holderRevision: string | undefined) => Effect.Effect<void>;
  readonly pollEveryMs?: number;
  readonly maxWaitMs?: number;
}): Effect.Effect<void, RunSkipped | SerialQueueTimedOut> =>
  Effect.gen(function* () {
    const { store, executionId, group, revision, stepDo } = opts;
    const pollEveryMs = opts.pollEveryMs ?? SERIAL_POLL_EVERY_MS;
    const maxWaitMs = opts.maxWaitMs ?? SERIAL_MAX_WAIT_MS;
    const { enqueuedAt } = yield* stepDo("serial-enqueue", () =>
      Effect.runPromise(store.enqueue(executionId, group, revision)),
    );
    // A COUNT, not a wall-clock bound, so the loop is replay-stable. The final
    // iteration's `wait` is a timeout whatever the clock says.
    const attempts = Math.max(1, Math.ceil(maxWaitMs / Math.max(1, pollEveryMs)) + 1);
    let reported: string | undefined | null = null;
    for (let i = 0; i < attempts; i++) {
      const observed = yield* stepDo(`serial-claim-${i}`, () =>
        Effect.runPromise(store.attempt(executionId, group, revision)),
      );
      const decision = decideSerial(
        observed,
        enqueuedAt,
        observed.now,
        i === attempts - 1 ? 0 : maxWaitMs,
      );
      if (decision.kind === "run") return;
      if (decision.kind === "superseded") {
        return yield* Effect.fail(
          new RunSkipped({
            reason:
              `superseded by ${short(decision.by)} — a newer dispatch of \`${group}\` ` +
              `arrived while this one waited, and only the newest waiter runs`,
          }),
        );
      }
      if (decision.kind === "timeout") {
        return yield* Effect.fail(
          new SerialQueueTimedOut({
            group,
            holderRevision: decision.holderRevision ?? "",
            waitedMs: decision.waitedMs,
          }),
        );
      }
      if (opts.onWait !== undefined && decision.holderRevision !== reported) {
        reported = decision.holderRevision;
        yield* opts.onWait(decision.holderRevision);
      }
      yield* opts.sleep(`serial-wait-${i}`, pollEveryMs);
    }
    // Unreachable — the final attempt runs, skips, or times out above.
    return yield* Effect.fail(
      new SerialQueueTimedOut({ group, holderRevision: "", waitedMs: maxWaitMs }),
    );
  });
