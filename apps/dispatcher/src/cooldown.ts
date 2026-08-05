// FlareDispatch Dispatcher — run cooldown enforcement.
//
// A run may declare `cooldown: { secondsDefault, scope, secondsKey? }`
// (specs/03-dsl.md): at most one execution per window per `{run}:{repo}:{scope}`
// bucket. This module is the shared check-and-arm both dispatch entry points
// call — Action-mode
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
// Window length: `cooldown.secondsDefault` is the fallback. When `secondsKey`
// is set, CONFIG_KV may override it at each dispatch (positive int, clamped to
// [60, 86400]); absent / junk → default.
//
// Concurrency: `get` then `put` is not atomic and KV is eventually consistent,
// so two dispatches racing inside the propagation window can both arm. That
// failure mode is bounded (one extra run, only on a tight race) and the
// semantic instance id still collapses same-sha races — accepted, same as the
// receiver-level dedup guard above it.

import type { CooldownSpec } from "@fractalboxdev/flare-dispatch-core";

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

/** Hard ceiling for a CONFIG_KV override — typo guard (e.g. ms pasted as sec). */
const KV_MAX_SECONDS = 86_400;

/**
 * Narrow a CONFIG_KV cooldown-window override to a positive integer count of
 * seconds, or `fallback` when unset / blank / non-numeric / non-positive. A
 * valid value is clamped to [{@link KV_MIN_TTL_SEC}, {@link KV_MAX_SECONDS}].
 *
 * Pure (no KV fetch) — the same narrow+clamp shape as the review-agent
 * `parseMaxTokens` / `parseMaxDiffChars` config overrides, so every
 * operator-tunable value across the codebase resolves the one way:
 * `parse<X>(getConfig(<x>Key), default<X>)`. The KV read stays at the call
 * site, keeping this unit-testable without a KV binding.
 */
export const parseCooldownSeconds = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(KV_MAX_SECONDS, Math.max(KV_MIN_TTL_SEC, n));
};

/** The cooldown bucket key: `{run}:{repo_}:{scope}`, one path segment. */
export const cooldownKey = (runName: string, repo: string, scope: string): string =>
  `cooldown:${runName}:${repo.replace(/\//g, "_")}:${scope}`;

/**
 * Check a run's cooldown and arm it when open.
 *
 * Returns `armed` (proceed with the dispatch — the window is now claimed for
 * `executionId`) or `cooling` (skip — answer with `priorExecutionId`). With no
 * `cooldown` on the run or no IDEMPOTENCY_KV binding, always `armed` and
 * writes nothing.
 */
export const checkAndArmCooldown = async (opts: {
  readonly kv: KVNamespace | undefined;
  /** CONFIG_KV — used only when `cooldown.secondsKey` is set. */
  readonly configKv?: KVNamespace;
  readonly runName: string;
  readonly cooldown: CooldownSpec<unknown> | undefined;
  readonly repo: string;
  readonly inputs: unknown;
  readonly executionId: string;
  readonly now: number;
}): Promise<CooldownVerdict> => {
  const { kv, cooldown } = opts;
  if (kv === undefined || cooldown === undefined) return { state: "armed" };

  // Precedence: CONFIG_KV override (via `secondsKey`) > the run's default.
  // The KV read happens here; the narrow+clamp is the pure `parseCooldownSeconds`.
  const override =
    cooldown.secondsKey !== undefined && opts.configKv !== undefined
      ? ((await opts.configKv.get(cooldown.secondsKey)) ?? undefined)
      : undefined;
  const seconds = parseCooldownSeconds(override, cooldown.secondsDefault);

  const key = cooldownKey(opts.runName, opts.repo, cooldown.scope(opts.inputs));
  const raw = await kv.get(key);
  if (raw !== null) {
    try {
      const record = JSON.parse(raw) as CooldownRecord;
      const elapsedSec = (opts.now - record.armedAt) / 1000;
      const remainingSec = seconds - elapsedSec;
      // The KV TTL is floored at 60s, so a record can outlive a sub-minute
      // window — honour the resolved `seconds`, not the key's residual TTL.
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
    expirationTtl: Math.max(KV_MIN_TTL_SEC, Math.ceil(seconds)),
  });
  return { state: "armed" };
};
