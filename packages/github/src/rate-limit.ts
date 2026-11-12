// The actuator rate limit keyed by GitHub App installation
// (specs/github-output.md § Installation quota; mameko specs/outbox.md § The
// actuator port and the actuator rate limit). The quota ledger holds what each
// installation's responses report and which permits are out; `InstallationQuota`
// serves it, from one isolate's memory or from the shared `InstallationQuota`
// Durable Object of each installation, and `ActuatorRateLimitLive` answers mameko's
// `acquire` and `release` from it, one permit per call. The drainer requests
// permits in grant order, so each request is decided as it comes.
import { CLAIM_TTL_MS } from "@fractalboxdev/mameko-kernel";
import {
  ActuatorRateLimit,
  type PermitAnswer,
  type PermitRequest,
} from "@fractalboxdev/mameko-ports";
import { Clock, Context, Effect, Layer, Ref, Schema } from "effect";
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
  /**
   * How long a granted permit counts as outstanding without a release: the drainer's claim on the row, after which
   * the row's call has expired unanswered (MAMEKO-OUT-039). It frees the slot of a drainer that stopped before it
   * released, which a shared ledger outlives.
   */
  readonly permitLifetimeMs: number;
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
  permitLifetimeMs: CLAIM_TTL_MS,
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

/** One granted permit not yet released. */
interface OutstandingPermit {
  readonly limitKey: string;
  readonly grantedAt: number;
}

/**
 * Every installation's state and every outstanding permit, as plain data, so the `InstallationQuota` Durable Object
 * stores it as it is.
 */
export interface QuotaLedger {
  readonly installations: Readonly<Record<string, InstallationState>>;
  readonly permits: Readonly<Record<string, OutstandingPermit>>;
  readonly issued: number;
}

export const emptyQuotaLedger: QuotaLedger = { installations: {}, permits: {}, issued: 0 };

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** The shared quota object could not be reached, so its answer is unknown. */
export class QuotaUnavailable extends Schema.TaggedError<QuotaUnavailable>()("QuotaUnavailable", {
  limitKey: Schema.String,
  message: Schema.String,
}) {}

export class InstallationQuota extends Context.Service<
  InstallationQuota,
  {
    readonly observe: (limitKey: string, observation: QuotaObservation) => Effect.Effect<void>;
    readonly acquire: (request: PermitRequest) => Effect.Effect<PermitAnswer>;
    readonly release: (permitId: string) => Effect.Effect<void>;
    /**
     * The installation's remaining budget as a share of its limit; 1 before any response reports one. A shared quota
     * that cannot be reached fails `QuotaUnavailable` rather than guess a share.
     */
    readonly remainingShare: (limitKey: string) => Effect.Effect<number, QuotaUnavailable>;
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

const stateOf = (options: QuotaOptions, ledger: QuotaLedger, limitKey: string) =>
  Object.hasOwn(ledger.installations, limitKey)
    ? ledger.installations[limitKey]!
    : fresh(options);

const withState = (
  ledger: QuotaLedger,
  limitKey: string,
  state: InstallationState,
): QuotaLedger => ({ ...ledger, installations: { ...ledger.installations, [limitKey]: state } });

/** The ledger without `permitId`, its installation's outstanding count lowered; an unknown permit changes nothing. */
export const releasePermit = (ledger: QuotaLedger, permitId: string): QuotaLedger => {
  if (!Object.hasOwn(ledger.permits, permitId)) return ledger;
  const { limitKey } = ledger.permits[permitId]!;
  const permits = { ...ledger.permits };
  delete permits[permitId];
  const s = ledger.installations[limitKey];
  return s === undefined
    ? { ...ledger, permits }
    : withState({ ...ledger, permits }, limitKey, {
        ...s,
        outstanding: Math.max(0, s.outstanding - 1),
      });
};

/** The ledger after one response's rate-limit headers for `limitKey` (FD-GH-057, FD-GH-060). */
export const observeQuota = (
  options: QuotaOptions,
  ledger: QuotaLedger,
  limitKey: string,
  o: QuotaObservation,
): QuotaLedger => {
  const s = stateOf(options, ledger, limitKey);
  return withState(ledger, limitKey, {
    ...s,
    limit: o.limit ?? s.limit,
    remaining: o.remaining ?? s.remaining,
    resetAt: o.resetAt ?? s.resetAt,
    blockedUntil: Math.max(s.blockedUntil, o.retryAfterAt ?? 0),
  });
};

/**
 * Decides one permit request at `now` against the ledger. A permit outstanding for `permitLifetimeMs` is released
 * first, since the drainer's claim on its row has expired (MAMEKO-OUT-039).
 */
export const acquirePermit = (
  options: QuotaOptions,
  ledger: QuotaLedger,
  request: PermitRequest,
  now: number,
): readonly [PermitAnswer, QuotaLedger] => {
  const live = Object.entries(ledger.permits)
    .filter(([, p]) => p.grantedAt <= now - options.permitLifetimeMs)
    .reduce((l, [id]) => releasePermit(l, id), ledger);
  const permitId = `${request.limitKey}:${live.issued + 1}`;
  const prev = stateOf(options, live, request.limitKey);
  const [answer, next] = decidePermit(options, prev, request, now, permitId);
  // Only a grant adds an outstanding permit.
  if (next.outstanding <= prev.outstanding)
    return [answer, withState(live, request.limitKey, next)];
  return [
    answer,
    {
      installations: { ...live.installations, [request.limitKey]: next },
      permits: { ...live.permits, [permitId]: { limitKey: request.limitKey, grantedAt: now } },
      issued: live.issued + 1,
    },
  ];
};

/** The installation's remaining budget as a share of its limit at `now`; 1 before any response reports one. */
export const remainingShareOf = (ledger: QuotaLedger, limitKey: string, now: number): number => {
  const s = Object.hasOwn(ledger.installations, limitKey)
    ? ledger.installations[limitKey]!
    : undefined;
  if (s === undefined || s.limit <= 0) return 1;
  if (s.resetAt > 0 && now >= s.resetAt) return 1;
  return s.remaining / s.limit;
};

/** One isolate's quota: the ledger in memory, which no other isolate sees. */
export const installationQuotaLayer = (options: QuotaOptions = quotaOptionsDefault) =>
  Layer.effect(
    InstallationQuota,
    Effect.gen(function* () {
      const ledger = yield* Ref.make<QuotaLedger>(emptyQuotaLedger);
      return {
        observe: (limitKey, o) => Ref.update(ledger, (l) => observeQuota(options, l, limitKey, o)),
        acquire: (request) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            return yield* Ref.modify(ledger, (l) => acquirePermit(options, l, request, now));
          }),
        remainingShare: (limitKey) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            return remainingShareOf(yield* Ref.get(ledger), limitKey, now);
          }),
        // An unknown or already released permit changes nothing, so a repeated release is harmless.
        release: (permitId) => Ref.update(ledger, (l) => releasePermit(l, permitId)),
      };
    }),
  );

/**
 * The remote surface of one `InstallationQuota` Durable Object: the ledger of the limit keys routed to it. The caller
 * passes its clock reading, so the object decides at the instant the drainer asks.
 */
export interface QuotaObject {
  observe(limitKey: string, observation: QuotaObservation): Promise<void>;
  acquire(request: PermitRequest, now: number): Promise<PermitAnswer>;
  release(permitId: string): Promise<void>;
  remainingShare(limitKey: string, now: number): Promise<number>;
}

/** A `QuotaObject` over one ledger; the Durable Object keeps it in its storage between calls. */
export const quotaObjectOver = (
  options: QuotaOptions,
  store: {
    readonly read: () => QuotaLedger;
    readonly write: (ledger: QuotaLedger) => Promise<void>;
  },
): QuotaObject => ({
  observe: (limitKey, o) => store.write(observeQuota(options, store.read(), limitKey, o)),
  acquire: async (request, now) => {
    const [answer, next] = acquirePermit(options, store.read(), request, now);
    await store.write(next);
    return answer;
  },
  release: async (permitId) => {
    const before = store.read();
    const next = releasePermit(before, permitId);
    if (next !== before) await store.write(next);
  },
  remainingShare: async (limitKey, now) => remainingShareOf(store.read(), limitKey, now),
});

/** The limit key a permit id was granted under: `<limit key>:<sequence>`. */
const limitKeyOfPermit = (permitId: string) => {
  const at = permitId.lastIndexOf(":");
  return at < 0 ? permitId : permitId.slice(0, at);
};

/** One call to a quota object; a rejection, or an object that cannot be named, fails with its message. */
const reach = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: (e) => (e instanceof Error ? e.message : String(e)) });

/**
 * The quota shared across isolates: every call for a limit key goes to the object `objectOf` names for it, the
 * `InstallationQuota` Durable Object of that installation (FD-ARCH-003). An object that cannot be reached grants
 * nothing: `acquire` answers `wait`, so no call goes out uncounted, and `remainingShare` fails `QuotaUnavailable`. An
 * observation or a release that does not reach it is logged; the next response reports the budget again, and an
 * unreleased permit frees its slot when its lifetime ends.
 */
export const installationQuotaObjectLayer = (
  objectOf: (limitKey: string) => QuotaObject,
  options: QuotaOptions = quotaOptionsDefault,
) =>
  Layer.succeed(InstallationQuota, {
    observe: (limitKey, o) =>
      reach(() => objectOf(limitKey).observe(limitKey, o)).pipe(
        Effect.catch((reason) =>
          Effect.logWarning("quota observation not recorded", { limitKey, reason }),
        ),
      ),
    acquire: (request) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* reach(() => objectOf(request.limitKey).acquire(request, now)).pipe(
          Effect.catch((reason) =>
            Effect.logWarning("quota unreachable; permit deferred", {
              limitKey: request.limitKey,
              reason,
            }).pipe(
              Effect.as<PermitAnswer>({ _tag: "wait", retryAt: now + options.concurrentRetryMs }),
            ),
          ),
        );
      }),
    release: (permitId) =>
      reach(() => objectOf(limitKeyOfPermit(permitId)).release(permitId)).pipe(
        Effect.catch((reason) =>
          Effect.logWarning("permit release not recorded", { permitId, reason }),
        ),
      ),
    remainingShare: (limitKey) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* reach(() => objectOf(limitKey).remainingShare(limitKey, now)).pipe(
          Effect.mapError((message) => new QuotaUnavailable({ limitKey, message })),
        );
      }),
  });

/** A repository scope, `<owner>/<repo>`, as a row keyed by its scope carries it. */
const isRepository = (limitKey: string) => limitKey.includes("/");

/**
 * The limit key of `job.record` and `verdict.record` rows, the profile's `delivery.limit_key` answer for both kinds
 * (FD-PROF-068). Their applier calls no GitHub API, so their permits are never drawn from an installation's quota.
 */
export const RECORDS_LIMIT_KEY = "records";
const RECORDS_PERMIT = `${RECORDS_LIMIT_KEY}-permit:`;

/**
 * mameko's actuator rate limit, served by the installation quota under the installation id, the key the client observes
 * each response under (FD-GH-056). A row keyed by its repository, as mameko keys a row when the binding is not applied
 * (MAMEKO-OUT-057), takes its permit from the quota of the installation that serves the repository. Any other key, an
 * installation id or the App's own key, is the quota key as it stands. A repository no installation serves keeps its
 * own key, since the applier refuses its row without a call; a directory read that fails answers `wait`, so no call
 * goes out under a quota it was not counted against. The `records` key is granted without the quota: its
 * `verdictRecord` applier takes no `InstallationQuota` permit (FD-GH-101).
 */
export const ActuatorRateLimitLive = Layer.effect(
  ActuatorRateLimit,
  Effect.gen(function* () {
    const quota = yield* InstallationQuota;
    const directory = yield* InstallationDirectory;
    const retryMs = quotaOptionsDefault.concurrentRetryMs;
    let records = 0;
    return {
      acquire: (request) =>
        request.limitKey === RECORDS_LIMIT_KEY
          ? Effect.sync((): PermitAnswer => ({
              _tag: "granted",
              permitId: `${RECORDS_PERMIT}${++records}`,
            }))
          : isRepository(request.limitKey)
            ? directory.installationFor(request.limitKey).pipe(
                Effect.flatMap((installation) =>
                  quota.acquire(
                    installation === null
                      ? request
                      : { ...request, limitKey: String(installation) },
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
      release: (permitId) =>
        permitId.startsWith(RECORDS_PERMIT) ? Effect.void : quota.release(permitId),
    };
  }),
);
