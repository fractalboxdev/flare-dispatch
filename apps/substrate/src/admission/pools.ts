// Pool policy: caps, selection, and the cap-sum guard
// (specs/adr/0004-admission-enforced-by-ticket.md, 0010-named-image-classes-policy-selected.md).
//
// One pool per image class, each with its own cap. That cap partition — not
// FIFO fairness — is what prevents CI starving interactive tasks. The pool a
// consumer lands in is policy-selected here from (consumer, recipe); no
// facade input names one (ADR-0010).
import type { PoolName, SubstrateRecipe } from "@fractalboxdev/flare-dispatch-substrate-contract";

/**
 * Consumer identity, carried by which named facade entrypoint the consumer's
 * service binding targets — a deploy-time, config-reviewed choice, never a
 * runtime field (ADR-0009).
 *
 * `self-check` is the substrate's own scratch consumer — the identity the
 * deploy probes (verify/) admit under, so a canary container is counted against
 * the same ceiling as consumer work and shows up in `poolStatus()` as itself
 * rather than borrowing a real consumer's name.
 */
export type ConsumerId = "dispatcher" | "fractalbot" | "self-check";

export const POOLS: readonly PoolName[] = ["lean", "browser", "agent", "task"];

export type PoolCaps = Readonly<Record<PoolName, number>>;

/**
 * Modest first-deploy partition. The dispatcher keeps its own fleet until it
 * adopts the facade (stage 2), so these caps deliberately leave headroom under
 * the account ceiling while both exist; they grow as the dispatcher's classes
 * are drained and deleted.
 */
export const POOL_CAPS_DEFAULT: PoolCaps = { lean: 6, browser: 3, agent: 3, task: 4 };

/**
 * The account-level Containers ceiling the cap-sum must stay within. The
 * dispatcher's current classes hold 40 instances of it; the guard below is
 * asserted against what remains for the substrate until the drain.
 */
export const CONTAINERS_CEILING_DEFAULT = 16;

/**
 * What the ceiling becomes once the dispatcher's classes are drained and
 * deleted: the 16 the substrate has plus the 40 its three classes held
 * (`RunSandbox` 16 + `RunSandboxBrowser` 16 + `RunSandboxAgent` 8).
 *
 * This is the freed headroom, not a guess at the account's hard limit — the
 * substrate never held more than the sum below, so a partition that fits it
 * cannot ask the platform for more than two fleets already had.
 */
export const CONTAINERS_CEILING_POST_ADOPTION = 56;

/**
 * The partition to run once the dispatcher's fleet is gone — the operator flips
 * `CONTAINERS_CEILING` and `POOL_CAPS` to these in one step (see the adoption
 * runbook), which is a vars change rather than a code deploy.
 *
 * The shape follows the load: `lean` carries every CI run in the dispatcher's
 * catalog, `browser` the e2e/demo runs, `agent` the review and self-heal tier,
 * `task` fractalbot's interactive work — which keeps its own cap precisely so a
 * CI burst cannot starve a human waiting in a thread (ADR-0004).
 */
export const POOL_CAPS_POST_ADOPTION: PoolCaps = { lean: 24, browser: 10, agent: 8, task: 12 };

/** Parse the optional `POOL_CAPS` var (JSON object). A typo degrades to the default. */
export function resolvePoolCaps(raw: string | undefined): PoolCaps {
  if (raw === undefined) return POOL_CAPS_DEFAULT;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<PoolName, unknown>>;
    const caps = { ...POOL_CAPS_DEFAULT };
    for (const pool of POOLS) {
      const value = parsed[pool];
      if (typeof value === "number" && Number.isInteger(value) && value > 0) caps[pool] = value;
    }
    return caps;
  } catch {
    return POOL_CAPS_DEFAULT;
  }
}

/**
 * The deploy-time assertion that the partition fits the physical ceiling
 * (ADR-0004): admitted work must never exceed the containers that can serve
 * it, or the platform starts refusing creates that no gate refused. Throws —
 * a misconfigured partition must fail the deploy, not degrade at 2am.
 */
export function validatePoolCaps(caps: PoolCaps, ceiling: number): void {
  const sum = POOLS.reduce((acc, pool) => acc + caps[pool], 0);
  if (sum > ceiling)
    throw new Error(
      `pool caps sum to ${sum}, over the Containers ceiling ${ceiling} — shrink a pool or raise the ceiling`,
    );
  for (const pool of POOLS)
    if (!Number.isInteger(caps[pool]) || caps[pool] <= 0)
      throw new Error(`pool ${pool} has a non-positive cap ${caps[pool]}`);
}

/**
 * Policy selection (ADR-0010): from (consumer, recipe), inside reviewed code —
 * never from a model or a payload. fractalbot's tasks run on the `task` image
 * (OpenCode harness et al.); the dispatcher lands on `lean` until its run
 * catalog migrates onto the facade with per-run class policy.
 */
export function selectPool(consumer: ConsumerId, _recipe: SubstrateRecipe): PoolName {
  return consumer === "fractalbot" ? "task" : "lean";
}

/** Suggested retry for a fail-fast refusal — one poll cadence. */
export const ADMISSION_RETRY_AFTER_MS = 20_000;
