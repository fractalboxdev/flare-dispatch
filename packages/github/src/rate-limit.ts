// The applier rate limit keyed by GitHub App installation
// (specs/github-output.md § Installation quota; mameko specs/outbox.md § The
// applier port and the applier rate limit). `InstallationQuota` holds what each
// installation's responses report and which permits are out; `ApplierRateLimitLive`
// answers mameko's `acquire` and `release` from it, one permit per call. The
// drainer requests permits in grant order, so each request is decided as it comes.
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
  /** Content-creating permits per minute and per hour (FD-GH-062); only `apply` calls write. */
  readonly perMinute: number;
  readonly perHour: number;
  /** Permits out at once per installation (FD-GH-063). */
  readonly concurrent: number;
  /** How long a request turned away at the concurrency bound waits before it asks again. */
  readonly concurrentRetryMs: number;
}

export const quotaOptionsDefault: QuotaOptions = {
  limit: 5000,
  reserveFraction: 0.1,
  lowestRankFraction: 0.3,
  lowestRank: 3,
  perMinute: 80,
  perHour: 500,
  concurrent: 8,
  concurrentRetryMs: 1000,
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
  /** Granted permits not yet released. */
  readonly outstanding: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export class InstallationQuota extends Context.Service<
  InstallationQuota,
  {
    readonly observe: (limitKey: string, observation: QuotaObservation) => Effect.Effect<void>;
    readonly acquire: (request: PermitRequest) => Effect.Effect<PermitAnswer>;
    readonly release: (permitId: string) => Effect.Effect<void>;
  }
>()("@fractalboxdev/flare-dispatch-github/InstallationQuota") {}

const roll = (w: Window, now: number, span: number): Window =>
  now - w.start >= span ? { start: now, count: 0 } : w;

/**
 * Decides one permit at `now` and returns the state after it. The checks run in order: a `Retry-After`, the
 * concurrency bound, an exhausted window, the reserve, the lowest-rank share, then the content-creating caps,
 * which count only `apply` calls. Every call, a read included, spends one unit of the installation's budget.
 */
export const decidePermit = (
  options: QuotaOptions,
  state: InstallationState,
  request: PermitRequest,
  now: number,
  permitId: string,
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
  const writes = request.call === "apply";
  if (now < s.blockedUntil) return wait(s.blockedUntil);
  if (s.outstanding >= options.concurrent) return wait(now + options.concurrentRetryMs);
  if (s.remaining <= 0) return wait(untilReset);
  if (!request.drawsReserve && s.remaining <= s.limit * options.reserveFraction)
    return wait(untilReset);
  if (
    !request.drawsReserve &&
    request.classRank >= options.lowestRank &&
    s.remaining <= s.limit * options.lowestRankFraction
  )
    return wait(untilReset);
  if (writes && s.minute.count >= options.perMinute) return wait(s.minute.start + MINUTE_MS);
  if (writes && s.hour.count >= options.perHour) return wait(s.hour.start + HOUR_MS);
  const counted = writes ? 1 : 0;
  return [
    { _tag: "granted", permitId },
    {
      ...s,
      remaining: s.remaining - 1,
      outstanding: s.outstanding + 1,
      minute: { ...s.minute, count: s.minute.count + counted },
      hour: { ...s.hour, count: s.hour.count + counted },
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
  outstanding: 0,
});

interface QuotaState {
  readonly installations: ReadonlyMap<string, InstallationState>;
  /** Each outstanding permit's limit key. */
  readonly permits: ReadonlyMap<string, string>;
  readonly issued: number;
}

export const installationQuotaLayer = (options: QuotaOptions = quotaOptionsDefault) =>
  Layer.effect(
    InstallationQuota,
    Effect.gen(function* () {
      const states = yield* Ref.make<QuotaState>({
        installations: new Map(),
        permits: new Map(),
        issued: 0,
      });
      const update = (key: string, f: (s: InstallationState) => InstallationState, now: number) =>
        Ref.update(states, (q) => ({
          ...q,
          installations: new Map(q.installations).set(
            key,
            f(q.installations.get(key) ?? fresh(options, now)),
          ),
        }));
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
            return yield* Ref.modify(states, (q) => {
              const permitId = `${request.limitKey}:${q.issued + 1}`;
              const prev = q.installations.get(request.limitKey) ?? fresh(options, now);
              const [answer, next] = decidePermit(options, prev, request, now, permitId);
              // Only a grant adds an outstanding permit.
              const granted = next.outstanding > prev.outstanding;
              return [
                answer,
                {
                  installations: new Map(q.installations).set(request.limitKey, next),
                  permits: granted ? new Map(q.permits).set(permitId, request.limitKey) : q.permits,
                  issued: granted ? q.issued + 1 : q.issued,
                },
              ] as const;
            });
          }),
        // An unknown or already released permit changes nothing, so a repeated release is harmless.
        release: (permitId) =>
          Ref.update(states, (q) => {
            const key = q.permits.get(permitId);
            const s = key === undefined ? undefined : q.installations.get(key);
            if (key === undefined || s === undefined) return q;
            const permits = new Map(q.permits);
            permits.delete(permitId);
            return {
              ...q,
              permits,
              installations: new Map(q.installations).set(key, {
                ...s,
                outstanding: Math.max(0, s.outstanding - 1),
              }),
            };
          }),
      };
    }),
  );

/** mameko's applier rate limit, served by the installation quota; the limit key is the installation id. */
export const ApplierRateLimitLive = Layer.effect(
  ApplierRateLimit,
  Effect.gen(function* () {
    const quota = yield* InstallationQuota;
    return { acquire: quota.acquire, release: quota.release };
  }),
);
