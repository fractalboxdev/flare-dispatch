// The exec fence — the only way a command reaches a container
// (specs/adr/0003-facade-only-consumption.md, 0005, 0007).
//
// Ported from fractalbot's reviewed reference (its src/exec.ts). The claim is
// narrow: a command that reaches the container *through this fence* runs
// inside a grant, and the grant is closed before the command's children can
// outlive it. `runFence` is a fixed sequence — approval floor, stale-revoke,
// ensure, apply, run, **kill, then revoke** — with the kill and the revoke in
// a `finally`, so a thrown command, a timeout and a budget abort all take the
// same exit.
//
// What made the fence a convention in the reference — `Sandbox`'s inherited,
// unfenced `exec` reachable by any binding-holder — is what ADR-0003 closes
// structurally here: consumers hold no DO binding at all, only the facade, and
// the facade's one exec path runs this fence inside the substrate's own DO.
//
// Two things are never workload-authored. The repository the egress policy is
// asserted against comes from the recipe, frozen consumer-side from inputs no
// model wrote; and the container the grant binds to is the DO's own id. The
// workload chooses only the command string — which is precisely why the fence
// has to hold without its cooperation (`postinstall`, `build.rs`,
// `conftest.py`).
import type {
  EnsureOutcome,
  EnsureResult,
  ExecReceipt,
  SubstrateRecipe,
  SubstrateRefusal,
} from "@fractalboxdev/flare-dispatch-substrate-contract";
import { repoSlug } from "@fractalboxdev/flare-dispatch-substrate-contract";
import { checkApprovalFloor } from "./approval";
import {
  applyGrant,
  buildGrant,
  revokeGrant,
  type Grant,
  type GrantParams,
  type GrantTarget,
} from "./egress";
import type { ApprovalAttestation } from "@fractalboxdev/flare-dispatch-substrate-contract";

/**
 * What the fence needs from a sandbox. All of it exists on the substrate's
 * Sandbox subclass for free — `Sandbox extends Container`, so `allowHost`,
 * `setOutboundByHost` and `killAllProcesses` are inherited public methods —
 * but the requirement belongs in a type rather than a comment: a sandbox that
 * satisfies less cannot be fenced and must not compile here. The DO class
 * declares `implements GuardedSandbox`, which is what stands between an SDK
 * rename and the fence throwing on every command.
 */
export interface GuardedSandbox extends GrantTarget {
  /** Ticket-gated (ADR-0004): refuses with a typed outcome, never boots unadmitted. */
  ensure(recipe: SubstrateRecipe): Promise<EnsureOutcome>;
  /** Dedupe on idempotency key, stream to artifacts, clamp the tail. */
  runTaskCommand(input: {
    command: string;
    idempotencyKey: string;
    logPath: string;
    timeoutMs: number;
    tailBytes: number;
  }): Promise<ExecReceipt>;
  /**
   * Returns the number of processes killed. Kills the SDK's *tracked*
   * processes; a double-forked grandchild that detached from the session is
   * not guaranteed to be among them, so this narrows the window rather than
   * closing it — see `KILL_COVERAGE_NOTE`.
   */
  killAllProcesses(): Promise<number>;
}

/**
 * The residual the kill does not cover, recorded rather than papered over
 * (an accepted residual in specs/platform.md). Between the kill and the revoke
 * completing, a detached child still holds the grant; what bounds it is the
 * container's own lifetime and the fact that a revoked grant leaves deny-all.
 */
export const KILL_COVERAGE_NOTE =
  "killAllProcesses covers tracked processes; a detached grandchild can outlive it";

/** A repo task that clones, installs and runs a suite is minutes, not seconds. */
export const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000;
/** Trailing output returned inline. The rest stays in the artifact log. */
export const DEFAULT_TAIL_BYTES = 4_096;

export type FenceInput = {
  /** Frozen consumer-side. The egress policy is asserted against `repo`. */
  recipe: SubstrateRecipe;
  /** The one possibly-model-authored value on this path. */
  command: string;
  /** Stable across retries of one durable step, distinct across steps. */
  idempotencyKey: string;
  /** Path under the execution's artifact prefix that stdout+stderr stream to. */
  logPath: string;
  /** The DO's own id — what the egress handler compares against. Never consumer-supplied. */
  containerId: string;
  timeoutMs?: number;
  tailBytes?: number;
  lfs?: boolean;
  approval?: ApprovalAttestation;
};

export type FenceOutcome =
  | {
      ok: true;
      ensured: EnsureResult;
      receipt: ExecReceipt;
      /** Hosts admitted for this command. Empty when the recipe grants no egress. */
      granted: string[];
      /** Processes the kill reported, before the revoke ran. */
      killed: number;
    }
  | { ok: false; refusal: SubstrateRefusal };

/**
 * A recipe that names no repository gets no grant at all — deny-all stays
 * exactly as the class posture ships it. Treating "no repo" as "no network"
 * rather than "no restriction" is the whole difference.
 */
function grantFor(input: FenceInput): Grant | undefined {
  if (!input.recipe.repo) return undefined;
  const params: GrantParams = {
    repo: repoSlug(input.recipe.repo),
    containerId: input.containerId,
    lfs: input.lfs ?? input.recipe.lfs,
  };
  return buildGrant(params);
}

/**
 * Run one command inside a grant, and close the grant before returning.
 *
 * The sequence is the security property, so it is written as one function with
 * no early returns between apply and revoke:
 *
 * 0. **The approval floor** (ADR-0007), before anything touches the container —
 *    a floor-matching command without a valid attestation is refused with a
 *    typed reason and no side effect.
 * 1. **Revoke first.** A caller that died mid-flight — isolate evicted,
 *    durable step timed out — leaves its grant applied on a container that
 *    outlives it. `ensure()` also does this as a backstop; doing it here too
 *    means this path is safe on its own.
 * 2. `ensure()`, always, before any exec. A container that slept between steps
 *    is rebuilt here rather than exec'd against — and the ticket gate
 *    (ADR-0004) answers here with a typed refusal when admission has lapsed.
 * 3. Apply, run, then in `finally`: **kill, then revoke**. A backgrounded
 *    process outlives the command that spawned it, so revoking first would
 *    close the grant on the foreground command while its children still hold
 *    it. A kill that throws must not skip the revoke.
 */
export async function runFence(
  sandbox: GuardedSandbox,
  input: FenceInput,
): Promise<FenceOutcome> {
  const command = input.command.trim();
  if (!command)
    return { ok: false, refusal: { kind: "recipe-rejected", reason: "empty command" } };

  const floorRefusal = await checkApprovalFloor(command, input.approval);
  if (floorRefusal) return { ok: false, refusal: floorRefusal };

  let grant: Grant | undefined;
  try {
    grant = grantFor(input);
  } catch (err) {
    return {
      ok: false,
      refusal: { kind: "recipe-rejected", reason: err instanceof Error ? err.message : "grant derivation failed" },
    };
  }

  // (1) Clear anything a previous call left applied for these hosts. Every
  // removal is a no-op when the host is absent, so this is safe on a cold
  // container.
  if (grant) await revokeGrant(sandbox, grant).catch(() => {});

  // (2) Never exec against a container that may not be there — and never
  // against one admission did not admit.
  const ensured = await sandbox.ensure(input.recipe);
  if (!ensured.ok) return { ok: false, refusal: ensured.refusal };

  if (grant) await applyGrant(sandbox, grant);

  let killed = 0;
  let receipt: ExecReceipt;
  try {
    receipt = await sandbox.runTaskCommand({
      command,
      idempotencyKey: input.idempotencyKey,
      logPath: input.logPath,
      timeoutMs: input.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
      tailBytes: input.tailBytes ?? DEFAULT_TAIL_BYTES,
    });
  } finally {
    // (3) Kill before revoke, and never let a failing kill skip the revoke —
    // the ordering is the point, and a swallowed revoke is a leaked grant.
    try {
      killed = await sandbox.killAllProcesses();
    } catch {
      // Recorded by the revoke that follows either way; a container that is
      // already gone cannot be holding a grant open.
    }
    if (grant) await revokeGrant(sandbox, grant);
  }

  // Built after the `finally` rather than inside the `try`. A return statement
  // evaluates its expression before the `finally` runs, so `killed` would
  // always read 0 — the kill happened, in the right order, and the number
  // reporting it would be a lie. That number is the only signal a
  // `killAllProcesses` contract change would surface.
  return {
    ok: true,
    ensured: { generation: ensured.generation, rebuilt: ensured.rebuilt },
    receipt,
    granted: grant?.allow ?? [],
    killed,
  };
}
