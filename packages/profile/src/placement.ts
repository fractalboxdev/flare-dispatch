// The eligible executor kinds of a request, the cloud entry a class opens at
// admission, and the delivery order of intent kinds. Each reads the accepted
// profile only. mameko's `requestConstraints` and `placementPolicy` fold decide
// the kinds; this module evaluates the profile's predicates, which mameko takes
// as facts, and carries `requires_posture`, which mameko's constraints omit.
import { requestConstraints } from "@fractalboxdev/mameko-coordinator";
import {
  eligibleKinds as foldConstraints,
  placeAtAdmission,
  placementIsolation,
  type ClassPlacement,
  type ConfidentialityMode,
  type ExecutorKind,
  type Isolation,
  type PostureTier,
} from "@fractalboxdev/mameko-kernel";
import { Match } from "effect";
import type {
  ClassEntry,
  IntentKindEntry,
  LifecycleTrigger,
  Predicate,
  Profile,
} from "./schema.ts";

/** What a placement constraint can see of a request. */
export interface PlacementRequest {
  readonly class: string;
  /** Placement labels from class resolution and capability labels the run declares, e.g. `expose-port`. */
  readonly labels: readonly string[];
  /**
   * The placement constraints the run definition declares, e.g. `cloud-pinned` for `worker-deploy` (FD-GATE-061) and
   * a publishing `sandbox-image` (FD-GATE-080). A declared `cloud-pinned` holds at every class.
   */
  readonly constraints?: readonly string[];
  readonly trigger?: string;
  /** False for a run whose definition declares no class. */
  readonly declaresClass?: boolean;
  readonly confidentiality?: ConfidentialityMode;
  readonly deviceLocalInput?: boolean;
  readonly needsLocalModel?: boolean;
}

export interface EligibleSet {
  /** The class's cloud kinds in preference order, then `device`. */
  readonly kinds: readonly ExecutorKind[];
  /** The constraints that held, generic and declared, as the execution row records them. */
  readonly constraints: readonly string[];
  readonly requiresPosture: PostureTier | null;
}

/**
 * The placement label of an execution whose egress profiles hold a grant that attaches a deployment secret. The declared
 * constraint `deployment-secret-grant` holds for it and removes `gha` (FD-ISO-022).
 */
export const DEPLOYMENT_SECRET_GRANT = "deployment-secret-grant";

/** A run's own grants per egress phase. */
export interface RunGrants {
  readonly setup: readonly string[];
  readonly agent: readonly string[];
}

/** The grants of an execution's egress profiles: the profile's base grants of both phases and the run's own. */
const egressGrantsOf = (profile: Profile, grants: RunGrants | undefined): readonly string[] => [
  ...new Set([
    ...profile.egress_profiles.setup.grants,
    ...profile.egress_profiles.agent.grants,
    ...(grants?.setup ?? []),
    ...(grants?.agent ?? []),
  ]),
];

/**
 * `deployment-secret-grant` when any grant of the execution's egress profiles attaches a deployment secret, by the
 * grant catalogue's `attachesDeploymentSecret`, else no label (FD-ISO-022).
 */
export const deploymentSecretGrantLabels = (
  profile: Profile,
  grants: RunGrants | undefined,
  attachesDeploymentSecret: (grant: string) => boolean,
): readonly string[] =>
  egressGrantsOf(profile, grants).some(attachesDeploymentSecret) ? [DEPLOYMENT_SECRET_GRANT] : [];

const holds = (p: Predicate, r: PlacementRequest): boolean => {
  if ("class" in p) return r.class === p.class;
  if ("label" in p) return r.labels.includes(p.label);
  if ("trigger" in p) return r.trigger === p.trigger;
  if ("undeclared_class" in p) return r.declaresClass === false;
  if ("not" in p) return !holds(p.not, r);
  if ("all" in p) return p.all.every((q) => holds(q, r));
  return p.any.some((q) => holds(q, r));
};

export const classNamed = (profile: Profile, name: string): ClassEntry | undefined =>
  profile.classes.find((c) => c.name === name);

const POSTURE_ORDER: readonly PostureTier[] = [
  "unmanaged",
  "managed-workstation",
  "attested-dedicated",
];
const stricter = (a: PostureTier | null, b: PostureTier): PostureTier =>
  a === null || POSTURE_ORDER.indexOf(b) > POSTURE_ORDER.indexOf(a) ? b : a;

/**
 * The executor kinds a request may run on: mameko's fold of the generic constraints and the profile's declared
 * constraints, intersected with the class's cloud kinds plus `device` where the class is device-eligible. An empty
 * set is unplaceable.
 */
/** What the placement's isolation depends on besides the class (MAMEKO-LEASE-084). */
export interface IsolationRequest {
  readonly class: string;
  /** The request carries `untrusted-input`: a fork pull request (FD-PROF-018). */
  readonly untrustedInput: boolean;
  /** The repository's confidentiality mode; a repository no rule classifies is `unclassified`. */
  readonly confidentiality: ConfidentialityMode;
  /** The run declares a grant in its `setup` or `agent` egress phase. */
  readonly declaresGrant: boolean;
}

/**
 * The weakest job sandbox isolation the placement admits: the class's `isolation` (`vm` when it declares none), which
 * mameko's `placementIsolation` raises from `none` to `container` for untrusted input, a scope that is not
 * `non-confidential` or a run that declares a grant, so no such request reaches a host-process device
 * (MAMEKO-LEASE-084, FD-PROF-065).
 */
export const isolationOf = (profile: Profile, request: IsolationRequest): Isolation =>
  placementIsolation({
    classIsolation: classNamed(profile, request.class)?.isolation ?? "vm",
    untrustedInput: request.untrustedInput,
    confidentiality: request.confidentiality,
    declaresGrant: request.declaresGrant,
  });

/**
 * What mameko's `requestConstraints` reads of a request: its facts, with the profile's predicates evaluated, and the
 * constraint parameters, with each declared constraint's predicate evaluated. Admission takes the same pair through its
 * placement binding (MAMEKO-ADM-091).
 */
export const placementInputs = (profile: Profile, request: PlacementRequest) => {
  const { placement } = profile;
  const kinds = ["cloudflare", "device", "aws", ...placement.launcher_kinds];
  const has = (label: string) => request.labels.includes(label);
  const held = placement.constraints.filter((c) => holds(c.holds_for, request));
  return {
    facts: {
      labels: request.labels,
      runLabels: request.labels,
      confidentiality: request.confidentiality ?? "unclassified",
      cloudPinned:
        (request.constraints ?? []).includes("cloud-pinned") ||
        holds(placement.cloud_pinned, request),
      cloudOnly: has("cloud-only") || holds(placement.cloud_only, request),
      localOnly: has("local-only") || holds(placement.local_only, request),
      deviceLocalInput: request.deviceLocalInput === true,
      needsLocalModel: request.needsLocalModel === true,
    },
    params: {
      kinds,
      cloudPinnedKinds: placement.cloud_pinned_kinds,
      declared: held.map((c) => ({ name: c.name, holds: true, removes: c.removes })),
    },
    held,
  };
};

export const eligibleKinds = (profile: Profile, request: PlacementRequest): EligibleSet => {
  const cls = classNamed(profile, request.class);
  const { facts, params, held } = placementInputs(profile, request);
  const kinds = params.kinds;
  const constraints = requestConstraints(facts, params);
  const eligible = foldConstraints(kinds, constraints);
  const classKinds: readonly ExecutorKind[] =
    cls === undefined
      ? []
      : [...cls.cloud_kinds, ...(cls.device_eligible === false ? [] : ["device"])];
  return {
    kinds: classKinds.filter((k) => eligible.includes(k)),
    constraints: constraints.map((c) => c.name),
    requiresPosture: held.reduce<PostureTier | null>(
      (tier, c) => (c.requires_posture === undefined ? tier : stricter(tier, c.requires_posture)),
      null,
    ),
  };
};

/**
 * The kernel's view of a class with a fixed claim deadline: `none` opens the cloud entry at admission, a duration
 * after it. A `staleness` class has no fixed deadline; its cloud entry opens at `stale_at`.
 */
export const classPlacement = (
  cls: ClassEntry,
  eligible: readonly ExecutorKind[],
): ClassPlacement | null =>
  Match.value(cls.claim_deadline).pipe(
    Match.when("none", () => ({ fixedClaimDeadlineMs: 0, cloudKinds: cloudOnly(eligible) })),
    Match.when("staleness", () => null),
    Match.orElse(({ seconds }) => ({
      fixedClaimDeadlineMs: seconds * 1000,
      cloudKinds: cloudOnly(eligible),
    })),
  );

const cloudOnly = (kinds: readonly ExecutorKind[]) => kinds.filter((k) => k !== "device");

/**
 * When a placement's cloud entry joins the queue: through the kernel for a fixed claim deadline, `stale_at` for a
 * `staleness` class, null when no cloud kind is eligible.
 */
export const cloudEligibleAt = (input: {
  readonly cls: ClassEntry;
  readonly eligible: readonly ExecutorKind[];
  readonly predictedMiss: boolean;
  readonly now: number;
  readonly staleAt: number;
}): number | null => {
  const fixed = classPlacement(input.cls, input.eligible);
  if (fixed === null) return cloudOnly(input.eligible).length === 0 ? null : input.staleAt;
  return placeAtAdmission({ cls: fixed, predictedMiss: input.predictedMiss, now: input.now })
    .cloudEligibleAt;
};

/**
 * `stale_at` for a `staleness` class: admission plus the declared fraction of the schedule period, or plus the
 * fallback for a run without a schedule.
 */
export const staleAt = (
  cls: ClassEntry,
  admittedAt: number,
  schedulePeriodMs: number | null,
): number | null =>
  cls.stale_after === undefined
    ? null
    : admittedAt +
      (schedulePeriodMs === null
        ? cls.stale_after.without_schedule_seconds * 1000
        : Math.floor(schedulePeriodMs * cls.stale_after.fraction));

/**
 * The key the control plane generates a lifecycle kind under: `cp:` and the kind with each `.` as `:`, plus
 * `:<epoch>` for a kind generated at every lease grant (mameko specs/profiles.md § Intent kinds).
 */
export const lifecycleKey = (kind: string, trigger: LifecycleTrigger, epoch: number): string => {
  const base = `cp:${kind.replaceAll(".", ":")}`;
  return trigger === "lease-granted" ? `${base}:${epoch}` : base;
};

const TIER_ORDER = { outcome: 0, effect: 1, progress: 2 } as const;

/** Permit order under the applier rate limit: the tier, then the kind's priority; class rank breaks ties after. */
export const deliveryOrder = (entry: IntentKindEntry): readonly [number, number] => [
  TIER_ORDER[entry.delivery_tier],
  entry.priority ?? 0,
];

/** Whether a kind's rows may take permits from the applier rate limit's reserve; outcome kinds do by default. */
export const drawsReserve = (entry: IntentKindEntry): boolean =>
  entry.draws_reserve ?? entry.delivery_tier === "outcome";
