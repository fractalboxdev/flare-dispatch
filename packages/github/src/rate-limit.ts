// The actuator rate limit keyed by GitHub App installation
// (specs/github-output.md § Installation quota; mameko specs/outbox.md § The
// actuator port and the actuator rate limit). `InstallationQuota` holds what each
// installation's responses report and which permits are out; `ActuatorRateLimitLive`
// answers mameko's `acquire` and `release` from it, one permit per call. The
// drainer requests permits in grant order, so each request is decided as it comes.
import {
  ActuatorRateLimit,
  type PermitAnswer,
  type PermitRequest,
} from "@fractalboxdev/mameko-ports";
import { Clock, Context, Effect, Layer, Ref } from "effect";
import { InstallationDirectory } from "./directory.ts";

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
  /** Content-creating permits in any 60 s and in any hour (FD-GH-062); only `apply` calls write. */
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

interface InstallationState {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: number;
  readonly blockedUntil: number;
  /** The grant time of each `apply` permit of the last hour, oldest first. */
  readonly applies: readonly number[];
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
    /** The installation's remaining budget as a share of its limit; 1 before any response reports one. */
    readonly remainingShare: (limitKey: string) => Effect.Effect<number>;
  }
>()("@fractalboxdev/flare-dispatch-github/InstallationQuota") {}

/**
 * The instant a further `apply` permit fits under `cap` grants in any `span` ms: `now` when fewer than `cap` of
 * `applies` fall in the span ending at `now`, else the instant enough of them leave it.
 */
const capFreeAt = (applies: readonly number[], now: number, span: number, cap: number): number => {
  const inSpan = applies.filter((t) => t > now - span);
  return inSpan.length < cap ? now : (inSpan[inSpan.length - cap] ?? now) + span;
};

/** Whether a row takes permits from the reserve: its kind draws it, or it carries the outcome (FD-GH-058). */
const drawsReserve = (request: PermitRequest): boolean =>
  request.drawsReserve || request.tier === "outcome";

/**
 * Decides one permit at `now` and returns the state after it. The checks run in order: a `Retry-After`, the
 * concurrency bound, an exhausted window, the reserve, the lowest-rank share, then the content-creating caps,
 * which count only `apply` calls over a sliding minute and hour. Every call, a read included, spends one unit of the
 * installation's budget.
 *
 * mameko's terminal write inserts the outcome row with `draws_reserve` 0, so a row of the `outcome` tier draws the
 * reserve as the profile's outcome kind does by default.
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
    applies: state.applies.filter((t) => t > now - HOUR_MS),
  };
  const untilReset = s.resetAt > now ? s.resetAt : now + MINUTE_MS;
  const wait = (retryAt: number): readonly [PermitAnswer, InstallationState] => [
    { _tag: "wait", retryAt },
    s,
  ];
  const writes = request.call === "apply";
  const reserve = drawsReserve(request);
  if (now < s.blockedUntil) return wait(s.blockedUntil);
  if (s.outstanding >= options.concurrent) return wait(now + options.concurrentRetryMs);
  if (s.remaining <= 0) return wait(untilReset);
  if (!reserve && s.remaining <= s.limit * options.reserveFraction) return wait(untilReset);
  if (
    !reserve &&
    request.classRank >= options.lowestRank &&
    s.remaining <= s.limit * options.lowestRankFraction
  )
    return wait(untilReset);
  if (writes) {
    const free = Math.max(
      capFreeAt(s.applies, now, MINUTE_MS, options.perMinute),
      capFreeAt(s.applies, now, HOUR_MS, options.perHour),
    );
    if (free > now) return wait(free);
  }
  return [
    { _tag: "granted", permitId },
    {
      ...s,
      remaining: s.remaining - 1,
      outstanding: s.outstanding + 1,
      applies: writes ? [...s.applies, now] : s.applies,
    },
  ];
};

const fresh = (options: QuotaOptions): InstallationState => ({
  limit: options.limit,
  remaining: options.limit,
  resetAt: 0,
  blockedUntil: 0,
  applies: [],
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
      const update = (key: string, f: (s: InstallationState) => InstallationState) =>
        Ref.update(states, (q) => ({
          ...q,
          installations: new Map(q.installations).set(
            key,
            f(q.installations.get(key) ?? fresh(options)),
          ),
        }));
      return {
        observe: (limitKey, o) =>
          update(limitKey, (s) => ({
            ...s,
            limit: o.limit ?? s.limit,
            remaining: o.remaining ?? s.remaining,
            resetAt: o.resetAt ?? s.resetAt,
            blockedUntil: Math.max(s.blockedUntil, o.retryAfterAt ?? 0),
          })),
        acquire: (request) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            return yield* Ref.modify(states, (q) => {
              const permitId = `${request.limitKey}:${q.issued + 1}`;
              const prev = q.installations.get(request.limitKey) ?? fresh(options);
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
        remainingShare: (limitKey) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const s = (yield* Ref.get(states)).installations.get(limitKey);
            if (s === undefined || s.limit <= 0) return 1;
            if (s.resetAt > 0 && now >= s.resetAt) return 1;
            return s.remaining / s.limit;
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

/** A repository scope, `<owner>/<repo>`, as a row keyed by its scope carries it. */
const isRepository = (limitKey: string) => limitKey.includes("/");

/**
 * mameko's actuator rate limit, served by the installation quota under the installation id, the key the client observes
 * each response under (FD-GH-056). A row keyed by its repository, as mameko keys a row when the binding is not applied
 * (MAMEKO-OUT-057), takes its permit from the quota of the installation that serves the repository. Any other key, an
 * installation id or the App's own key, is the quota key as it stands. A repository no installation serves keeps its
 * own key, since the applier refuses its row without a call; a directory read that fails answers `wait`, so no call
 * goes out under a quota it was not counted against.
 */
export const ActuatorRateLimitLive = Layer.effect(
  ActuatorRateLimit,
  Effect.gen(function* () {
    const quota = yield* InstallationQuota;
    const directory = yield* InstallationDirectory;
    const retryMs = quotaOptionsDefault.concurrentRetryMs;
    return {
      acquire: (request) =>
        isRepository(request.limitKey)
          ? directory.installationFor(request.limitKey).pipe(
              Effect.flatMap((installation) =>
                quota.acquire(
                  installation === null ? request : { ...request, limitKey: String(installation) },
                ),
              ),
              Effect.catch((e) =>
                Effect.gen(function* () {
                  const now = yield* Clock.currentTimeMillis;
                  yield* Effect.logWarning("installation read failed; permit deferred", {
                    limitKey: request.limitKey,
                    reason: e.message,
                  });
                  return { _tag: "wait", retryAt: now + retryMs } as const;
                }),
              ),
            )
          : quota.acquire(request),
      release: quota.release,
    };
  }),
);
