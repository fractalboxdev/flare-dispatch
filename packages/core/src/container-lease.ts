// @fractalboxdev/flare-dispatch-core — container-lease: the pure lease decision logic.
//
// Two runs that share a sandbox container id (the contention boundary) must
// never execute concurrently. The runtime serializes them with a lease: before
// a run touches its container for the first time it acquires a lease keyed on
// the container id; a second run for the same id waits until the first releases
// (or the lease goes stale and is reclaimed).
//
// This module holds ONLY the pure decision: given the lease row currently on
// record for a container id (or none), the id of the run trying to acquire, and
// the current time, decide what that run should do — proceed, wait, or reclaim a
// stale lease. The strongly-consistent storage + the bounded poll loop live in
// the runtime layer (`@fractalboxdev/flare-dispatch-runtime-cf` `container-lease-d1.ts`),
// which calls in here for every state transition. Keeping the logic pure mirrors
// `artifact-tar-path.ts` / `sandbox-clone-url.ts`: it is exercised by plain
// vitest without a container runtime (`vitest-pool-workers` cannot boot one).
//
// The lease is a liveness lease, not a perfect mutex: a holder refreshes its
// `heartbeatAt` while it works, and a lease whose heartbeat is older than the
// TTL is presumed dead (the Worker holding it was evicted mid-run, the run
// crashed, etc.) and may be reclaimed. Without reclamation a single crashed run
// would wedge a container id forever. The TTL must therefore exceed the
// heartbeat interval by a comfortable margin so a live-but-busy holder is never
// mistaken for dead.
//
// Spec: specs/03-dsl.md § sandbox.

/** A lease record as stored — the holder + its last liveness heartbeat. */
export type LeaseRecord = {
  /** The container id the lease serializes — the lease primary key. */
  readonly containerId: string;
  /** The execution id currently holding the lease. */
  readonly holder: string;
  /** ms-epoch when the lease was first acquired. */
  readonly acquiredAt: number;
  /** ms-epoch of the holder's most recent heartbeat. */
  readonly heartbeatAt: number;
};

/**
 * The decision for a run trying to acquire a container's lease, given the row
 * currently on record (or `undefined` when no lease exists).
 *
 *   - `acquire`  — no live lease: the caller may take it (insert a fresh row).
 *   - `held`     — WE already hold it (re-entrant acquire by the same holder):
 *                  proceed without re-inserting.
 *   - `reclaim`  — a lease exists but its heartbeat is stale (holder presumed
 *                  dead): the caller may steal it (overwrite the row).
 *   - `wait`     — a live lease held by ANOTHER execution: the caller must poll
 *                  and retry.
 */
export type LeaseDecision =
  | { readonly _kind: "acquire" }
  | { readonly _kind: "held" }
  | { readonly _kind: "reclaim"; readonly staleHolder: string }
  | { readonly _kind: "wait"; readonly holder: string; readonly heldForMs: number };

/** A lease is stale when its last heartbeat predates `now - ttlMs`. */
export const isLeaseStale = (lease: LeaseRecord, now: number, ttlMs: number): boolean =>
  now - lease.heartbeatAt > ttlMs;

/**
 * Decide what a run should do when it finds `lease` on record for the container
 * id it wants. Pure: no I/O, no clock read — `now` and `ttlMs` are passed in so
 * the same inputs always yield the same decision (replay-safe + unit-testable).
 *
 * @param lease   the row currently on record, or `undefined` when none exists.
 * @param holder  the execution id of the run trying to acquire.
 * @param now     ms-epoch the decision is evaluated at.
 * @param ttlMs   heartbeat staleness ceiling — a lease older than this is dead.
 */
export const decideLease = (
  lease: LeaseRecord | undefined,
  holder: string,
  now: number,
  ttlMs: number,
): LeaseDecision => {
  if (lease === undefined) return { _kind: "acquire" };
  if (lease.holder === holder) return { _kind: "held" };
  if (isLeaseStale(lease, now, ttlMs)) {
    return { _kind: "reclaim", staleHolder: lease.holder };
  }
  return {
    _kind: "wait",
    holder: lease.holder,
    heldForMs: Math.max(0, now - lease.acquiredAt),
  };
};

/**
 * Derive the number of poll attempts a bounded acquire loop should make from
 * its overall wait ceiling + poll interval. At least one attempt; one attempt
 * per `pollEveryMs` up to `waitTimeoutMs`. A COUNT, not a wall-clock read, so
 * the loop stays replay-deterministic across a Workflow checkpoint resume —
 * exactly the bound `waitForChildren` uses for its child-poll loop.
 */
export const leaseAcquireAttempts = (waitTimeoutMs: number, pollEveryMs: number): number =>
  Math.max(1, Math.ceil(waitTimeoutMs / Math.max(1, pollEveryMs)));
