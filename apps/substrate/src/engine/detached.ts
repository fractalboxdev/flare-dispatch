// What the fence's teardown kills, and what it spares
// (specs/adr/0012-processes-that-outlive-the-exec-fence.md).
//
// The decision lives here rather than inline in the Durable Object for the
// reason every other `engine/` module exists: the workers test pool runs with
// no container engine, so a rule that only exists inside a method reaching
// `listProcesses()` is a rule no test can drive. This is the most consequential
// branch ADR-0012 adds — it decides which processes survive past a grant
// revoke — and it must be reachable by a plain unit test.
//
// Pure: no Cloudflare imports, no I/O.

/**
 * The shape the SDK's `listProcesses()` returns, narrowed to what matters here.
 *
 * **What that registry contains is the whole reason this module is small.**
 * `listProcesses`, `killProcess` and `killAllProcesses` all address
 * `/api/process/*` in the container server, and only `startProcess` puts
 * anything there — `exec` posts to `/api/execute`, a different endpoint with a
 * different lifecycle (`@cloudflare/sandbox@0.12.4`,
 * `dist/sandbox-CyqG4jca.js:1754, 2187-2211`). So the registry holds exactly the
 * processes the substrate declared detached, and nothing an `exec`'d command
 * spawns ever appears in it.
 */
export type TrackedProcess = { id: string };

/**
 * What the fence's teardown does with the processes it can see.
 *
 * - `kill-all` — nothing was declared detached, so the teardown is
 *   `killAllProcesses()` exactly as it was before ADR-0012. This is the
 *   overwhelming majority of executions, and keeping it on the *same* SDK call
 *   rather than a walk that happens to kill everything means the hot path grows
 *   no new failure mode and no new round trip.
 * - `kill-listed` — a run declared a long-lived process, so the teardown kills
 *   the tracked set minus the declared ids.
 */
export type FenceKillPlan =
  | { mode: "kill-all" }
  | { mode: "kill-listed"; ids: readonly string[] };

/**
 * Decide the teardown from the declared set alone. Called before
 * `listProcesses()` so the common case never makes that call.
 */
export function fenceKillMode(spared: readonly string[]): "kill-all" | "kill-listed" {
  return spared.length === 0 ? "kill-all" : "kill-listed";
}

/**
 * The processes to kill: everything tracked that was not declared detached.
 *
 * Matching is by exact id, and the ids are substrate-assigned UUIDs — never
 * container pids, which are reused and would let a fresh process inherit a
 * sparing decision made about a dead one.
 *
 * A declared id the container no longer tracks is simply absent from the
 * result; it needs no special case, because a process that is gone cannot hold
 * a grant. The reverse — a tracked process nobody declared — is precisely what
 * the fence exists to kill, including one the workload backgrounded itself.
 */
export function fencedKillSet(
  spared: readonly string[],
  tracked: readonly TrackedProcess[],
): string[] {
  const declared = new Set(spared);
  return tracked.filter((process) => !declared.has(process.id)).map((process) => process.id);
}

/**
 * Which declarations still name something the container knows about.
 *
 * A record exists for one purpose — to spare its process from the fence's kill —
 * so a record for a process the registry has forgotten spares nothing and only
 * keeps the teardown on the selective path forever. The fence reaps with this,
 * at the one point where `listProcesses()` has already been paid for.
 *
 * An *exited* process is still in the registry (status `completed` / `failed` /
 * `killed`), so it survives the reap and `detachedStatus` can keep reporting its
 * exit code. Only a forgotten id is dropped.
 */
export function survivingDeclarations(
  declared: readonly string[],
  tracked: readonly TrackedProcess[],
): string[] {
  const known = new Set(tracked.map((process) => process.id));
  return declared.filter((id) => known.has(id));
}
