// The placement subject of the `diff` job (specs/verification.md § V-DIFF): each event is one placement of a
// `worker-deploy` or `sandbox-image` request, answered by the TypeScript path intake takes (the catalogue's
// `requestPlacement`, the profile's `eligibleKinds` and mameko's `unplaceable`) and by `oracle placement`, compiled
// from `formal/FdFormal/Placement.lean`. The generator draws the profile from FlareDispatch's own profile at every
// phase and from mutations of its classes, predicates, launcher kinds and declared constraints, keeping
// `cloud_pinned` and `cloud_pinned_kinds` the profile's, which the Lean model fixes.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildProfile,
  eligibleKinds,
  placementInputs,
  type ClassEntry,
  type ConfidentialityMode,
  type Phase,
  type PlacementRequest,
  type Predicate,
  type Profile,
} from "@fractalboxdev/flare-dispatch-profile";
import { unplaceable } from "@fractalboxdev/mameko-kernel";
import fc from "fast-check";
import type { DiffSubject } from "../../../ops/src/verification/diff.ts";
import { pipeOracle, type PipeOracle } from "../../../ops/src/verification/pipe-oracle.ts";
import { lookupRun, requestPlacement, sandboxImagePlacement } from "../../src/spec.ts";

export type PlacementRun = "worker-deploy" | "sandbox-image";

/** The parts of a profile placement reads, besides `cloud_pinned` and `cloud_pinned_kinds`. */
export interface ProfilePlacement {
  readonly classes: readonly {
    readonly name: string;
    readonly cloudKinds: readonly string[];
    readonly deviceEligible: boolean | null;
  }[];
  readonly cloudOnly: Predicate;
  readonly localOnly: Predicate;
  readonly launcherKinds: readonly string[];
  readonly constraints: readonly {
    readonly name: string;
    readonly holdsFor: Predicate;
    readonly removes: readonly string[];
  }[];
}

/** One placement: the run and its `publish` input, the request class resolution gave, the profile and the executors. */
export interface PlacementEvent {
  readonly run: PlacementRun;
  readonly publish: boolean;
  readonly class: string;
  /** The labels class resolution returned and any recorded placement constraint. */
  readonly labels: readonly string[];
  readonly trigger: string | null;
  readonly declaresClass: boolean | null;
  readonly confidentiality: ConfidentialityMode | null;
  readonly deviceLocalInput: boolean;
  readonly needsLocalModel: boolean;
  readonly profile: ProfilePlacement;
  /** The capability labels each executor kind advertises; a kind not listed advertises none. */
  readonly advertised: readonly { readonly kind: string; readonly labels: readonly string[] }[];
}

export interface PlacementAnswer {
  /** `sandboxImagePlacement(publish).className` for a `sandbox-image` request, null for `worker-deploy`. */
  readonly className: string | null;
  /** The constraints the run declares for these inputs. */
  readonly constraints: readonly string[];
  /** The request's labels: class resolution's, then the run's capability labels. */
  readonly labels: readonly string[];
  readonly cloudPinned: boolean;
  readonly eligible: readonly string[];
  /** The eligible kinds that advertise every label of the request. */
  readonly placeable: readonly string[];
}

const BASE = buildProfile("production", 4);

/** FlareDispatch's profile with the event's classes and placement parameters. */
const profileOf = (p: ProfilePlacement): Profile => ({
  ...BASE,
  classes: p.classes.map((c): ClassEntry => ({
    ...(BASE.classes.find((b) => b.name === c.name) ?? BASE.classes[0]!),
    name: c.name,
    cloud_kinds: [...c.cloudKinds],
    ...(c.deviceEligible === null ? {} : { device_eligible: c.deviceEligible }),
  })),
  placement: {
    ...BASE.placement,
    cloud_only: p.cloudOnly,
    local_only: p.localOnly,
    launcher_kinds: [...p.launcherKinds],
    constraints: p.constraints.map((c) => ({
      name: c.name,
      holds_for: c.holdsFor,
      removes: [...c.removes],
    })),
  },
});

const specOf = (run: PlacementRun) => {
  const found = lookupRun("production", run);
  if (found._tag !== "Available") throw new Error(`${run} is not in the production catalogue`);
  return found.entry.spec;
};

/**
 * The placement intake gives the request (packages/intake/src/submit.ts `placementRequest`): the run's declared
 * constraints and capability labels for these inputs, the profile's eligible kinds, and of those the kinds that
 * advertise every label of the request (mameko's `unplaceable`).
 */
export const runPlacement = (e: PlacementEvent): PlacementAnswer => {
  const declared = requestPlacement(specOf(e.run), { publish: e.publish });
  const request: PlacementRequest = {
    class: e.class,
    labels: [...new Set([...e.labels, ...declared.labels])],
    constraints: declared.constraints,
    ...(e.trigger === null ? {} : { trigger: e.trigger }),
    ...(e.declaresClass === null ? {} : { declaresClass: e.declaresClass }),
    ...(e.confidentiality === null ? {} : { confidentiality: e.confidentiality }),
    deviceLocalInput: e.deviceLocalInput,
    needsLocalModel: e.needsLocalModel,
  };
  const profile = profileOf(e.profile);
  const eligible = eligibleKinds(profile, request).kinds;
  const advertised = Object.fromEntries(e.advertised.map((a) => [a.kind, a.labels]));
  return {
    className: e.run === "sandbox-image" ? sandboxImagePlacement(e.publish).className : null,
    constraints: declared.constraints,
    labels: request.labels,
    cloudPinned: placementInputs(profile, request).facts.cloudPinned,
    eligible,
    placeable: eligible.filter((k) => unplaceable([k], request.labels, advertised) === null),
  };
};

const CLASSES = ["release", "required", "interactive", "batch"];
const KINDS = ["cloudflare", "aws", "gha", "device"];
const LABELS = [
  "untrusted-input",
  "release-matrix",
  "apple-build",
  "reproduction",
  "expose-port",
  "cloud-only",
  "local-only",
  "container-artifact",
  "linux-arm64",
];
const TRIGGERS = ["tag-push", "push", "pull_request"];

const leaf: fc.Arbitrary<Predicate> = fc.oneof(
  fc.constantFrom(...CLASSES, "nightly").map((c): Predicate => ({ class: c })),
  fc.constantFrom(...LABELS).map((l): Predicate => ({ label: l })),
  fc.constantFrom(...TRIGGERS).map((t): Predicate => ({ trigger: t })),
  fc.constant<Predicate>({ undeclared_class: true }),
);

const predicate: fc.Arbitrary<Predicate> = fc.letrec<{ p: Predicate }>((tie) => ({
  p: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    { weight: 4, arbitrary: leaf },
    { weight: 1, arbitrary: tie("p").map((p): Predicate => ({ not: p })) },
    {
      weight: 1,
      arbitrary: fc.array(tie("p"), { maxLength: 3 }).map((ps): Predicate => ({ all: ps })),
    },
    {
      weight: 1,
      arbitrary: fc.array(tie("p"), { maxLength: 3 }).map((ps): Predicate => ({ any: ps })),
    },
  ),
})).p;

/** FlareDispatch's profile at a phase, as the event carries it. */
const phaseProfile = (phase: Phase): ProfilePlacement => {
  const p = buildProfile("production", phase);
  return {
    classes: p.classes.map((c) => ({
      name: c.name,
      cloudKinds: [...c.cloud_kinds],
      deviceEligible: c.device_eligible ?? null,
    })),
    cloudOnly: p.placement.cloud_only,
    localOnly: p.placement.local_only,
    launcherKinds: [...p.placement.launcher_kinds],
    constraints: p.placement.constraints.map((c) => ({
      name: c.name,
      holdsFor: c.holds_for,
      removes: [...c.removes],
    })),
  };
};

const mutatedProfile: fc.Arbitrary<ProfilePlacement> = fc.record({
  classes: fc.uniqueArray(
    fc.record({
      name: fc.constantFrom(...CLASSES),
      cloudKinds: fc.subarray(["cloudflare", "aws", "gha"]),
      deviceEligible: fc.constantFrom(null, true, false),
    }),
    { selector: (c) => c.name, maxLength: 4 },
  ),
  cloudOnly: predicate,
  localOnly: predicate,
  launcherKinds: fc.subarray(["gha"]),
  constraints: fc.array(
    fc.record({
      name: fc.constantFrom("a", "b", "c"),
      holdsFor: predicate,
      removes: fc.subarray(KINDS),
    }),
    { maxLength: 3 },
  ),
});

const profilePlacement: fc.Arbitrary<ProfilePlacement> = fc.oneof(
  fc.constantFrom(0, 1, 2, 3, 4).map((phase) => phaseProfile(phase as Phase)),
  mutatedProfile,
);

/** What one kind advertises: every label of the request, every label but `container-artifact`, or a draw. */
const advertisedFor = (requestLabels: readonly string[]) =>
  fc.oneof(
    fc.constant([...requestLabels]),
    fc.constant(requestLabels.filter((l) => l !== "container-artifact")),
    fc.subarray(LABELS),
  );

export const placementEvent: fc.Arbitrary<PlacementEvent> = fc
  .record({
    run: fc.constantFrom<PlacementRun>("worker-deploy", "sandbox-image"),
    publish: fc.boolean(),
    class: fc.constantFrom(...CLASSES, "release", "unknown"),
    labels: fc.subarray(LABELS, { maxLength: 3 }),
    trigger: fc.constantFrom(null, null, ...TRIGGERS),
    declaresClass: fc.constantFrom(null, null, true, false),
    confidentiality: fc.constantFrom<ConfidentialityMode | null>(
      null,
      "non-confidential",
      "unclassified",
      "confidential-model",
      "confidential-compute",
    ),
    deviceLocalInput: fc.constantFrom(false, false, false, true),
    needsLocalModel: fc.boolean(),
    profile: profilePlacement,
  })
  .chain((r) => {
    const requestLabels = [
      ...new Set([
        ...r.labels,
        ...(r.run === "sandbox-image" && r.publish ? ["container-artifact"] : []),
      ]),
    ];
    return fc
      .tuple(...KINDS.map(() => fc.option(advertisedFor(requestLabels), { nil: undefined })))
      .map((ads): PlacementEvent => ({
        ...r,
        advertised: KINDS.flatMap((kind, i) =>
          ads[i] === undefined ? [] : [{ kind, labels: ads[i] as string[] }],
        ),
      }));
  });

/** The oracle executable `lake build oracle` writes in `formal/`. */
export const ORACLE_PATH = fileURLToPath(
  new URL("../../../../formal/.lake/build/bin/oracle", import.meta.url),
);

let oracle: PipeOracle<PlacementEvent, PlacementAnswer> | undefined;

const startOracle = (): PipeOracle<PlacementEvent, PlacementAnswer> => {
  if (!existsSync(ORACLE_PATH))
    throw new Error(`no oracle at ${ORACLE_PATH}: run \`lake build oracle\` in formal/`);
  return pipeOracle<PlacementEvent, PlacementAnswer>(ORACLE_PATH, ["placement"]);
};

export const subject: DiffSubject<PlacementEvent, PlacementAnswer> = {
  kernel: "placement",
  run: runPlacement,
  oracle: (e) => (oracle ??= startOracle()).ask(e),
  arbitrary: placementEvent,
  close: () => {
    oracle?.close();
    oracle = undefined;
  },
};
