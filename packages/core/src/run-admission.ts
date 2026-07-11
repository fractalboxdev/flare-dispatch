// @fractalbox/flare-dispatch-core — run-admission: the pure admission decision logic.
//
// A merge burst can create more concurrent run executions than the container
// pool has instances (`max_instances: 16` per class). Without a gate the
// excess runs boot anyway, fail `ContainerLaunchFailed` / `PortNeverOpened`,
// and post red checks indistinguishable from test failures. The runtime
// therefore meters runs through a global, per-pool counting semaphore: every
// run enqueues before its body starts, polls an atomic FIFO claim until a
// slot frees, and times out loudly once it has queued longer than the
// dispatch-age ceiling.
//
// This module holds ONLY the pure decision: given what one claim attempt
// observed (did the atomic claim land? how many live waiters are ahead? how
// many slots are busy?), the row's enqueue time, and the current time, decide
// what the run should do — proceed, keep waiting, or give up. The
// strongly-consistent storage + the durable-step poll loop live in the
// runtime layer (`@fractalbox/flare-dispatch-runtime-cf` `run-admission-d1.ts` + the
// dispatcher's `RunWorkflow`), which call in here every iteration. Keeping
// the logic pure mirrors `container-lease.ts`: it is exercised by plain
// vitest without a container runtime.
//
// The admission slot is a liveness slot, not a perfect semaphore: a holder
// refreshes its `heartbeatAt` while it runs, and an admitted row whose
// heartbeat is older than the TTL stops counting toward the pool (the Worker
// holding it was evicted mid-run, the run crashed, etc.). Without that decay
// a single crashed run would shrink the pool forever. Queued rows decay on a
// much shorter waiter TTL so a dead waiter never blocks the FIFO line.
//
// Issue: #109. Pattern sibling: container-lease.ts (#91).

/** The container pool a run is admitted into — one semaphore per pool. */
export type AdmissionPool = "lean" | "browser" | "agent";

/**
 * What one claim attempt observed, read atomically by the runtime layer:
 * whether OUR atomic claim landed, and — when it did not — where we stand.
 * `position` counts live queued rows ahead of us (the FIFO line); `poolBusy`
 * counts live admitted rows in our pool (slots in use).
 */
export type AdmissionObservation = {
  /** The atomic FIFO claim UPDATE changed our row — we hold a slot. */
  readonly admitted: boolean;
  /** Live queued rows ahead of us (0 when we are next, or when admitted). */
  readonly position: number;
  /** Live admitted rows in our pool (slots currently in use). */
  readonly poolBusy: number;
};

/**
 * The decision for a run polling for admission, given one attempt's
 * observation.
 *
 *   - `admit`   — the claim landed: proceed into the run body.
 *   - `wait`    — the pool is full (or peers are ahead): poll again.
 *   - `timeout` — the run has queued past `maxQueueAgeMs`: fail loudly with
 *                 `AdmissionTimedOut` instead of hanging toward the Workflow
 *                 wall-clock cap. Never reached once admitted — a slot taken
 *                 at the deadline is kept.
 */
export type AdmissionDecision =
  | { readonly _kind: "admit" }
  | {
      readonly _kind: "wait";
      readonly position: number;
      readonly poolBusy: number;
    }
  | {
      readonly _kind: "timeout";
      readonly queuedForMs: number;
      readonly position: number;
      readonly poolBusy: number;
    };

/**
 * Decide what a queued run should do after one claim attempt. Pure: no I/O,
 * no clock read — `now` is the timestamp the observation was taken at (read
 * inside the same durable step), so the same inputs always yield the same
 * decision (replay-safe + unit-testable).
 *
 * @param observed       what the attempt saw (claim outcome, position, busy).
 * @param enqueuedAt     ms-epoch the run first enqueued — the dispatch-age basis.
 * @param now            ms-epoch the observation was taken at.
 * @param maxQueueAgeMs  dispatch-age ceiling — queued at least this long ⇒ timeout.
 */
export const decideAdmission = (
  observed: AdmissionObservation,
  enqueuedAt: number,
  now: number,
  maxQueueAgeMs: number,
): AdmissionDecision => {
  if (observed.admitted) return { _kind: "admit" };
  const queuedForMs = Math.max(0, now - enqueuedAt);
  if (queuedForMs >= maxQueueAgeMs) {
    return {
      _kind: "timeout",
      queuedForMs,
      position: observed.position,
      poolBusy: observed.poolBusy,
    };
  }
  return {
    _kind: "wait",
    position: observed.position,
    poolBusy: observed.poolBusy,
  };
};

/**
 * Derive the number of claim attempts a bounded admission loop should make
 * from the dispatch-age ceiling + poll interval. At least one attempt; one
 * attempt per `pollEveryMs` up to `maxQueueAgeMs`. A COUNT, not a wall-clock
 * read, so the loop stays replay-deterministic across a Workflow checkpoint
 * resume — exactly the bound `leaseAcquireAttempts` and `waitForChildren`
 * use for their poll loops.
 */
export const admissionAcquireAttempts = (
  maxQueueAgeMs: number,
  pollEveryMs: number,
): number =>
  Math.max(1, Math.ceil(maxQueueAgeMs / Math.max(1, pollEveryMs)));
