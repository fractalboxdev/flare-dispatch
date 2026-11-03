// FlareDispatch's reuse policy: when a registered rehearsal concludes a pull-request check in place of a placed run
// (specs/local-scheduler.md § Rehearsal reuse, MAMEKO-LOCAL-075). Every read the policy decides on that fails names no
// rehearsal, so the run is placed as usual.
import { PostureSource, ReusePolicy } from "@fractalboxdev/mameko-ports";
import { Clock, Context, Effect, Exit, Layer, Schema } from "effect";
import { CHECK_KINDS } from "../declaration.ts";
import { LocalStore, Provenance, type RegistrationRecord } from "./store.ts";

export class ReuseReadFailed extends Schema.TaggedError<ReuseReadFailed>()("ReuseReadFailed", {
  source: Schema.String,
  detail: Schema.String,
}) {}

/** The pull-request run admission asks about, as the control plane passes it with the reuse key. */
export const ReuseRequest = Schema.Struct({
  ...Provenance.fields,
  scopeId: Schema.String,
  repository: Schema.String,
  baseBranch: Schema.String,
  checkName: Schema.String,
  run: Schema.String,
  placementRule: Schema.String,
  /** The intent kinds the run declares. */
  intentKinds: Schema.Array(Schema.String),
  environmentNames: Schema.Array(Schema.String),
});
export type ReuseRequest = typeof ReuseRequest.Type;

/** A repository's reuse policy from its repo manifest: off by default. */
export interface RepoReusePolicy {
  readonly reuse: boolean;
  /** Groups of platforms the repository names as equivalent (FD-LOCAL-084). */
  readonly equivalentPlatforms: readonly (readonly string[])[];
}

export class ReuseInputs extends Context.Service<
  ReuseInputs,
  {
    readonly repoPolicy: (repository: string) => Effect.Effect<RepoReusePolicy, ReuseReadFailed>;
    /** The base branch's required set, read from GitHub (ruleset and branch protection). */
    readonly readRequiredSet: (
      repository: string,
      branch: string,
    ) => Effect.Effect<readonly string[], ReuseReadFailed>;
    /** Whether the control plane issued or re-bound this capacity-lease epoch. */
    readonly epochIssued: (
      leaseId: string,
      epoch: number,
    ) => Effect.Effect<boolean, ReuseReadFailed>;
  }
>()("@fractalboxdev/flare-dispatch-agentic/ReuseInputs") {}

/** The required-set cache TTL, 10 min (FD-PROF-014). */
export const REQUIRED_SET_TTL_MS = 600_000;

/**
 * The required set through a 10 min cache: an entry older than its TTL is read again before use, and a failed read
 * fails, so the policy names nothing (FD-LOCAL-080, FD-LOCAL-081).
 */
export const requiredSetCache = (ttlMs = REQUIRED_SET_TTL_MS) => {
  const cache = new Map<string, { readonly at: number; readonly set: readonly string[] }>();
  return (repository: string, branch: string) =>
    Effect.gen(function* () {
      const inputs = yield* ReuseInputs;
      const now = yield* Clock.currentTimeMillis;
      const key = `${repository}#${branch}`;
      const hit = cache.get(key);
      if (hit !== undefined && now - hit.at < ttlMs) return hit.set;
      const set = yield* inputs.readRequiredSet(repository, branch);
      cache.set(key, { at: now, set });
      return set;
    });
};

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

const platformsMatch = (policy: RepoReusePolicy, a: string, b: string) =>
  a === b || policy.equivalentPlatforms.some((group) => group.includes(a) && group.includes(b));

/**
 * Whether one registered rehearsal may stand in for the run: registered and given its nonce before it started, under
 * an epoch the control plane issued or re-bound, matching tree hash, base commit, run-definition digest, image digest,
 * platform and environment names, with an accepted `device-signed` statement and a `success` outcome (FD-LOCAL-078,
 * FD-LOCAL-084), signed by a device whose posture is not `unmanaged` (FD-LOCAL-085).
 */
const standsIn = (request: ReuseRequest, policy: RepoReusePolicy, r: RegistrationRecord) =>
  Effect.gen(function* () {
    const inputs = yield* ReuseInputs;
    const posture = yield* PostureSource;
    const matches =
      r.startedAt !== null &&
      r.registeredAt <= r.startedAt &&
      r.statementAccepted &&
      r.statementId !== null &&
      r.outcome === "success" &&
      r.run === request.run &&
      r.repository === request.repository &&
      r.treeHash === request.treeHash &&
      r.baseCommit === request.baseCommit &&
      r.runDigest === request.runDigest &&
      r.imageDigest === request.imageDigest &&
      platformsMatch(policy, r.platform, request.platform) &&
      sameSet(r.environmentNames, request.environmentNames);
    if (!matches) return false;
    if (!(yield* inputs.epochIssued(r.leaseId, r.epoch))) return false;
    return (yield* posture.posture(r.executorId)) !== "unmanaged";
  });

const decodeRequest = Schema.decodeUnknownExit(ReuseRequest);

/** The reuse decision: the registered rehearsal's execution id, or null to place the run as usual. */
export const reuseRehearsal = (
  requiredSet: ReturnType<typeof requiredSetCache>,
  request: unknown,
  reuseKey: string,
) =>
  Effect.gen(function* () {
    const decoded = decodeRequest(request);
    if (Exit.isFailure(decoded)) return null;
    const r = decoded.value;
    const inputs = yield* ReuseInputs;
    const policy = yield* inputs.repoPolicy(r.repository);
    if (!policy.reuse) return null;
    if (r.placementRule === "cloud-only") return null;
    if (r.intentKinds.some((k) => !(CHECK_KINDS as readonly string[]).includes(k))) return null;
    const required = yield* requiredSet(r.repository, r.baseBranch);
    if (required.includes(r.checkName)) return null;
    const store = yield* LocalStore;
    for (const candidate of yield* store.byReuseKey(r.scopeId, reuseKey))
      if (yield* standsIn(r, policy, candidate)) return candidate.executionId;
    return null;
  }).pipe(
    Effect.catchTags({
      ReuseReadFailed: () => Effect.succeed(null),
      LocalStoreFailed: () => Effect.succeed(null),
    }),
  );

/**
 * The summary line of a check a rehearsal concludes: it names the rehearsal, the device and the statement
 * (FD-LOCAL-086).
 */
export const rehearsalSummary = (
  record: Pick<RegistrationRecord, "executionId" | "executorId" | "statementId">,
) =>
  `A rehearsal produced this verdict: local execution ${record.executionId} on device ${record.executorId}, device-signed statement ${record.statementId ?? "none"}.`;

/** The `ReusePolicy` port Layer. */
export const reusePolicyLayer: Layer.Layer<
  ReusePolicy,
  never,
  LocalStore | ReuseInputs | PostureSource
> = Layer.effect(
  ReusePolicy,
  Effect.gen(function* () {
    const context = yield* Effect.context<LocalStore | ReuseInputs | PostureSource>();
    const requiredSet = requiredSetCache();
    return {
      reuse: (request, reuseKey) =>
        reuseRehearsal(requiredSet, request, reuseKey).pipe(Effect.provide(context)),
    };
  }),
);
