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
 */
export type ConsumerId = "dispatcher" | "fractalbot";

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
