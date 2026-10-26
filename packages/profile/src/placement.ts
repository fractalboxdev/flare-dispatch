// The placement fold over the profile's constraints, the cloud entry a class
// opens at admission, and the delivery order of intent kinds. Each reads the
// accepted profile only; the coordinator's own `placementPolicy` replaces the
// fold once mameko ships it.
import {
  placeAtAdmission,
  type ClassPlacement,
  type ConfidentialityMode,
  type ExecutorKind,
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
  readonly trigger?: string;
  /** False for a run whose definition declares no class. */
  readonly declaresClass?: boolean;
  readonly confidentiality?: ConfidentialityMode;
  readonly deviceLocalInput?: boolean;
}

export interface EligibleSet {
  /** The class's cloud kinds in preference order, then `device`. */
  readonly kinds: readonly ExecutorKind[];
  /** The constraints that held, generic and declared, as the execution row records them. */
  readonly constraints: readonly string[];
  readonly requiresPosture: PostureTier | null;
}

const holds = (p: Predicate, r: PlacementRequest): boolean =>
  Match.value(p).pipe(
    Match.tag("Class", ({ name }) => r.class === name),
    Match.tag("Label", ({ name }) => r.labels.includes(name)),
    Match.tag("Trigger", ({ kind }) => r.trigger === kind),
    Match.tag("UndeclaredClass", () => r.declaresClass === false),
    Match.tag("Not", ({ predicate }) => !holds(predicate, r)),
    Match.tag("All", ({ predicates }) => predicates.every((q) => holds(q, r))),
    Match.tag("Any", ({ predicates }) => predicates.some((q) => holds(q, r))),
    Match.exhaustive,
  );

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
 * The executor kinds a request may run on: the generic constraints of mameko specs/admission-qos.md § Placement
 * constraints and the profile's declared constraints, each only removing kinds, intersected with the class's
 * cloud kinds plus `device` where the class is device-eligible. An empty set is unplaceable.
 */
export const eligibleKinds = (profile: Profile, request: PlacementRequest): EligibleSet => {
  const { placement } = profile;
  const cls = classNamed(profile, request.class);
  let kinds = new Set<ExecutorKind>(["cloudflare", "device", "aws", ...placement.launcher_kinds]);
  const applied: string[] = [];
  let requiresPosture: PostureTier | null = null;

  const keepOnly = (name: string, keep: readonly string[]) => {
    applied.push(name);
    kinds = new Set([...kinds].filter((k) => keep.includes(k)));
  };
  const remove = (name: string, removed: readonly string[]) => {
    applied.push(name);
    kinds = new Set([...kinds].filter((k) => !removed.includes(k)));
  };
  const cloudKinds = () => [...kinds].filter((k) => k !== "device");
  const has = (label: string) => request.labels.includes(label);

  if (holds(placement.cloud_pinned, request))
    keepOnly("cloud-pinned", placement.cloud_pinned_kinds);
  if (has("expose-port")) keepOnly("expose-port", ["cloudflare"]);
  if (has("untrusted-input")) remove("untrusted-input", ["device"]);
  if (has("cloud-only") || holds(placement.cloud_only, request)) remove("cloud-only", ["device"]);
  if (request.confidentiality === "confidential-compute")
    remove("confidential-compute", cloudKinds());
  if (has("local-only") || holds(placement.local_only, request)) remove("local-only", cloudKinds());
  if (request.deviceLocalInput === true) remove("device-local", cloudKinds());
  for (const c of placement.constraints) {
    if (!holds(c.holds_for, request)) continue;
    remove(c.name, c.removes);
    if (c.requires_posture !== undefined)
      requiresPosture = stricter(requiresPosture, c.requires_posture);
  }

  const classKinds: readonly ExecutorKind[] =
    cls === undefined
      ? []
      : [...cls.cloud_kinds, ...(cls.device_eligible === false ? [] : ["device"])];
  return {
    kinds: classKinds.filter((k) => kinds.has(k)),
    constraints: applied,
    requiresPosture,
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
