// The applier rate limit keyed by GitHub App installation
// (specs/github-output.md § Installation quota; mameko specs/outbox.md § The
// applier port and the applier rate limit). `InstallationQuota` holds what each
// installation's responses report; `ApplierRateLimitLive` answers mameko's
// `acquire` from it, one permit per call.
import {
  ApplierRateLimit,
  type PermitAnswer,
  type PermitRequest,
} from "@fractalboxdev/mameko-ports";
import { Clock, Context, Effect, Layer, Ref } from "effect";

/** What one GitHub response says about its installation's budget. */
export interface QuotaObservation {
  readonly limit?: number;
  readonly remaining?: number;
  /** Epoch ms at which the window resets. */
  readonly resetAt?: number;
  /** Epoch ms before which no call may go out (`Retry-After`). */
  readonly retryAfterAt?: number;
}

export interface QuotaOptions {
  /** The budget assumed before any response reports one. */
  readonly limit: number;
  /** At or below this share of the limit only reserve-drawing kinds get a permit (FD-GH-058). */
  readonly reserveFraction: number;
  /** At or below this share the lowest-rank class gets no permit unless it draws the reserve (FD-GH-059). */
  readonly lowestRankFraction: number;
  readonly lowestRank: number;
  /** Content-creating permits per minute and per hour (FD-GH-062). */
  readonly perMinute: number;
  readonly perHour: number;
}

export const quotaOptionsDefault: QuotaOptions = {
  limit: 5000,
  reserveFraction: 0.1,
  lowestRankFraction: 0.3,
  lowestRank: 3,
  perMinute: 80,
  perHour: 500,
};

interface Window {
  readonly start: number;
  readonly count: number;
}

interface InstallationState {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: number;
  readonly blockedUntil: number;
  readonly minute: Window;
  readonly hour: Window;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export class InstallationQuota extends Context.Service<
  InstallationQuota,
  {
    readonly observe: (limitKey: string, observation: QuotaObservation) => Effect.Effect<void>;
    readonly acquire: (request: PermitRequest) => Effect.Effect<PermitAnswer>;
  }
>()("@fractalboxdev/flare-dispatch-github/InstallationQuota") {}

const roll = (w: Window, now: number, span: number): Window =>
  now - w.start >= span ? { start: now, count: 0 } : w;

/**
 * Decides one permit at `now` and returns the state after it. The checks run in order: a `Retry-After`, an
 * exhausted window, the reserve, the lowest-rank share, then the content-creating caps.
 */
export const decidePermit = (
  options: QuotaOptions,
  state: InstallationState,
  request: PermitRequest,
  now: number,
): readonly [PermitAnswer, InstallationState] => {
  const reset = state.resetAt > 0 && now >= state.resetAt;
  const s: InstallationState = {
    ...state,
    remaining: reset ? state.limit : state.remaining,
    resetAt: reset ? 0 : state.resetAt,
    minute: roll(state.minute, now, MINUTE_MS),
    hour: roll(state.hour, now, HOUR_MS),
  };
  const untilReset = s.resetAt > now ? s.resetAt : now + MINUTE_MS;
  const wait = (retryAt: number): readonly [PermitAnswer, InstallationState] => [
    { _tag: "wait", retryAt },
    s,
  ];
  if (now < s.blockedUntil) return wait(s.blockedUntil);
  if (s.remaining <= 0) return wait(untilReset);
  if (!request.drawsReserve && s.remaining <= s.limit * options.reserveFraction)
    return wait(untilReset);
  if (
    !request.drawsReserve &&
    request.classRank >= options.lowestRank &&
    s.remaining <= s.limit * options.lowestRankFraction
  )
    return wait(untilReset);
  if (s.minute.count >= options.perMinute) return wait(s.minute.start + MINUTE_MS);
  if (s.hour.count >= options.perHour) return wait(s.hour.start + HOUR_MS);
  return [
    { _tag: "granted" },
    {
      ...s,
      remaining: s.remaining - 1,
      minute: { ...s.minute, count: s.minute.count + 1 },
      hour: { ...s.hour, count: s.hour.count + 1 },
    },
  ];
};

const fresh = (options: QuotaOptions, now: number): InstallationState => ({
  limit: options.limit,
  remaining: options.limit,
  resetAt: 0,
  blockedUntil: 0,
  minute: { start: now, count: 0 },
  hour: { start: now, count: 0 },
});

export const installationQuotaLayer = (options: QuotaOptions = quotaOptionsDefault) =>
  Layer.effect(
    InstallationQuota,
    Effect.gen(function* () {
      const states = yield* Ref.make(new Map<string, InstallationState>());
      const update = (key: string, f: (s: InstallationState) => InstallationState, now: number) =>
        Ref.update(states, (m) => new Map(m).set(key, f(m.get(key) ?? fresh(options, now))));
      return {
        observe: (limitKey, o) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            yield* update(
              limitKey,
              (s) => ({
                ...s,
                limit: o.limit ?? s.limit,
                remaining: o.remaining ?? s.remaining,
                resetAt: o.resetAt ?? s.resetAt,
                blockedUntil: Math.max(s.blockedUntil, o.retryAfterAt ?? 0),
              }),
              now,
            );
          }),
        acquire: (request) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            return yield* Ref.modify(states, (m) => {
              const [answer, next] = decidePermit(
                options,
                m.get(request.limitKey) ?? fresh(options, now),
                request,
                now,
              );
              return [answer, new Map(m).set(request.limitKey, next)] as const;
            });
          }),
      };
    }),
  );

/** mameko's applier rate limit, served by the installation quota; the limit key is the installation id. */
export const ApplierRateLimitLive = Layer.effect(
  ApplierRateLimit,
  Effect.gen(function* () {
    const quota = yield* InstallationQuota;
    return { acquire: quota.acquire };
  }),
);
