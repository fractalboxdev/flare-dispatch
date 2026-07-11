// FlareDispatch Dispatcher — run cooldown enforcement.
//
// A run may declare `cooldown: { seconds, scope }` (specs/03-dsl.md): at most
// one execution per window per `{run}:{repo}:{scope}` bucket. This module is
// the shared check-and-arm both dispatch entry points call — Action-mode
// `/v1/dispatch` (routes/dispatch.ts) and the webhook receiver
// (routes/webhook.ts). Schedule mode is exempt: crons self-pace.
//
// Storage is IDEMPOTENCY_KV — the same optional binding receiver-level dedup
// rides on. The KV value records `{ executionId, armedAt }` so a skipped
// dispatch can answer with the PRIOR execution's id (the caller gets a real,
// linkable execution — its dispatch collapsed into the recent one, mirroring
// the semantic-id dedup contract). Without the binding the cooldown is not
// enforced: best-effort by design, identical to receiver dedup's posture.
//
// Concurrency: `get` then `put` is not atomic and KV is eventually consistent,
// so two dispatches racing inside the propagation window can both arm. That
// failure mode is bounded (one extra run, only on a tight race) and the
// semantic instance id still collapses same-sha races — accepted, same as the
// receiver-level dedup guard above it.

import type { CooldownSpec } from "@fractalbox/flare-dispatch-core";

/** What the KV value under a cooldown key records. */
type CooldownRecord = {
  readonly executionId: string;
  readonly armedAt: number;
};

/** The verdict for one dispatch attempt against a run's cooldown. */
export type CooldownVerdict =
  | { readonly state: "armed" }
  | {
      readonly state: "cooling";
      /** The execution this dispatch collapsed into. */
      readonly priorExecutionId: string;
      /** Whole seconds until the window reopens (≥ 1). */
      readonly retryAfterSec: number;
    };

/** KV minimum `expirationTtl` — windows shorter than this still persist 60s. */
const KV_MIN_TTL_SEC = 60;

/** The cooldown bucket key: `{run}:{repo_}:{scope}`, one path segment. */
export const cooldownKey = (
  runName: string,
  repo: string,
  scope: string,
): string => `cooldown:${runName}:${repo.replace(/\//g, "_")}:${scope}`;

/**
 * Check a run's cooldown and arm it when open.
 *
 * Returns `armed` (proceed with the dispatch — the window is now claimed for
 * `executionId`) or `cooling` (skip — answer with `priorExecutionId`). With no
 * `cooldown` on the run or no KV binding, always `armed` and writes nothing.
 */
export const checkAndArmCooldown = async (opts: {
  readonly kv: KVNamespace | undefined;
  readonly runName: string;
  readonly cooldown: CooldownSpec<unknown> | undefined;
  readonly repo: string;
  readonly inputs: unknown;
  readonly executionId: string;
  readonly now: number;
}): Promise<CooldownVerdict> => {
  const { kv, cooldown } = opts;
  if (kv === undefined || cooldown === undefined) return { state: "armed" };

  const key = cooldownKey(opts.runName, opts.repo, cooldown.scope(opts.inputs));
  const raw = await kv.get(key);
  if (raw !== null) {
    try {
      const record = JSON.parse(raw) as CooldownRecord;
      const elapsedSec = (opts.now - record.armedAt) / 1000;
      const remainingSec = cooldown.seconds - elapsedSec;
      // The KV TTL is floored at 60s, so a record can outlive a sub-minute
      // window — honour the run's `seconds`, not the key's residual TTL.
      if (remainingSec > 0 && typeof record.executionId === "string") {
        return {
          state: "cooling",
          priorExecutionId: record.executionId,
          retryAfterSec: Math.max(1, Math.ceil(remainingSec)),
        };
      }
    } catch {
      // Unparseable record (manual KV edit, older value shape): treat the
      // window as open rather than wedging the run until the TTL clears.
    }
  }

  const record: CooldownRecord = {
    executionId: opts.executionId,
    armedAt: opts.now,
  };
  await kv.put(key, JSON.stringify(record), {
    expirationTtl: Math.max(KV_MIN_TTL_SEC, Math.ceil(cooldown.seconds)),
  });
  return { state: "armed" };
};
