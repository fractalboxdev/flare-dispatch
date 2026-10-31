// The profile validator: mameko's `validateProfile`, `validateProfileContext` and
// `validateReasonKinds` over the decoded document, plus the checks of mameko
// specs/profiles.md § Profile validator that those functions leave out. The
// validator is pure and reports every rejection.
import {
  ProfileLoader,
  projectProfile,
  resolveLines,
  validateProfile as validateProjected,
  validateProfileContext,
  validateReasonKinds,
  withDefaults,
  type Bindings,
  type ProfileContext,
} from "@fractalboxdev/mameko-coordinator";
import { classLines, type ConfidentialityMode } from "@fractalboxdev/mameko-kernel";
import { decodeProfile, type ProfileDocument } from "@fractalboxdev/mameko-ports";
import { Effect, Match, Schema } from "effect";
import { acceptanceReasonKinds, type Deployment, type SpendConfig } from "./document.ts";
import { eligibleKinds } from "./placement.ts";
import { ProfileRejected, type PlacementShape, type Profile, type Rejection } from "./schema.ts";

const BUILT_IN_CLOUD_KINDS = ["cloudflare", "aws"] as const;
const CONFIDENTIALITY_MODES: readonly ConfidentialityMode[] = [
  "non-confidential",
  "unclassified",
  "confidential-model",
  "confidential-compute",
];
const PPM = 1_000_000;

/** What the validator reads beside the document: the registered code and the deployment's configuration. */
export interface ValidationContext {
  /** Which registration values the deployment accepts. */
  readonly deployment: Deployment;
  /** The bindings and appliers registered in code. */
  readonly bindings: Bindings;
  /** The kinds a registered run may emit or the control plane generates. */
  readonly emittedKinds: readonly string[];
  readonly runs: ProfileContext["runs"];
  /** The runtime adapter's pools with their admission caps. */
  readonly declaredPools: ProfileContext["declared_pools"];
  readonly spend: SpendConfig;
}

const byRank = (p: Profile) => [...p.classes].sort((a, b) => a.rank - b.rank);

const reserveOf = (c: Profile["classes"][number], spend: SpendConfig): number =>
  c.reserve === undefined
    ? 0
    : c.reserve === "measured"
      ? spend.measured_reserve_min
      : (spend.reserves[c.reserve] ?? 0);

/** Each class's line in micro-USD under the spend configuration (mameko specs/spend.md § Budget, reserves and lines). */
export const linesOf = (p: Profile, spend: SpendConfig): Readonly<Record<string, number>> => {
  const classes = byRank(p);
  const lowest = classes.at(-1);
  const ratio = typeof lowest?.line === "object" ? lowest.line : undefined;
  const { lines } = classLines({
    budget: spend.budget,
    fixed: spend.fixed,
    classes: classes.map((c, i) => ({
      name: c.name,
      reserve: i === classes.length - 1 ? null : reserveOf(c, spend),
    })),
    lineRatioPpm: Math.round((ratio?.general_band_ratio ?? 0) * PPM),
    floorRatioPpm: Math.round((ratio?.floor_ratio ?? 0) * PPM),
  });
  return resolveLines(p.classes, {
    budgetMicroUsd: spend.budget,
    reservesMicroUsd: Object.fromEntries(p.classes.map((c) => [c.name, reserveOf(c, spend)])),
    lowestLineMicroUsd: lowest === undefined ? 0 : (lines[lowest.name] ?? 0),
  });
};

/** Catalogue checks mameko's validator leaves to a decode that does not make them. */
const classes = (p: Profile): Rejection[] => {
  const cloudKinds = new Set<string>([...BUILT_IN_CLOUD_KINDS, ...p.placement.launcher_kinds]);
  const lowest = Math.max(...p.classes.map((c) => c.rank));
  const out: Rejection[] = [];
  for (const c of p.classes) {
    const path = `classes[${c.name}]`;
    for (const k of c.cloud_kinds)
      if (!cloudKinds.has(k))
        out.push({
          item: "classes",
          path: `${path}.cloud_kinds`,
          reason: `unknown cloud kind ${k}`,
        });
    if ((c.claim_deadline === "staleness") !== (c.stale_after !== undefined))
      out.push({
        item: "classes",
        path: `${path}.stale_after`,
        reason: "stale_after goes with a staleness claim deadline, and only with it",
      });
    if (p.reclaim_policy[c.name] === undefined)
      out.push({
        item: "reclaim_policy",
        path: `reclaim_policy.${c.name}`,
        reason: "class has no reclaim policy",
      });
    const expectsLine =
      c.rank === 0 ? "budget" : c.rank === lowest ? "ratio" : "next-above-less-reserve";
    const line = typeof c.line === "string" ? c.line : "ratio";
    if (line !== expectsLine)
      out.push({
        item: "classes",
        path: `${path}.line`,
        reason: `lines do not nest: rank ${c.rank} takes ${expectsLine}`,
      });
  }
  return out;
};

/** Trigger and tier rules beyond mameko's: its validator checks `admitted` and `lease-granted` payloads only. */
const intentKinds = (p: Profile): Rejection[] => {
  const out: Rejection[] = [];
  for (const [kind, k] of Object.entries(p.intent_kinds)) {
    const path = `intent_kinds.${kind}`;
    if ((k.on === "accepted" || k.on === "progress") && k.payload === undefined)
      out.push({
        item: "intent_kinds",
        path: `${path}.payload`,
        reason: "lifecycle kind without a payload",
      });
    if (k.on !== "progress" && k.coalesce_key !== undefined)
      out.push({
        item: "intent_kinds",
        path: `${path}.coalesce_key`,
        reason: "a coalesce_key goes with on: progress, and only with it",
      });
  }
  const outcomeKinds = Object.values(p.intent_kinds).filter((k) => k.delivery_tier === "outcome");
  if (outcomeKinds.length !== 1)
    out.push({
      item: "intent_kinds",
      path: "intent_kinds",
      reason: "exactly one kind carries the outcome to the surface",
    });
  return out;
};

const matches = (shape: PlacementShape, cls: string, labels: readonly string[]): boolean =>
  (shape.class === "any" || shape.class === cls) &&
  (shape.labels === "any" || shape.labels.every((l) => labels.includes(l)));

/**
 * Every `placement.required` shape must leave a non-empty eligible set at every class it covers (MAMEKO-PROF-014,
 * which mameko's `validateProfile` does not carry).
 */
const placement = (p: Profile): Rejection[] => {
  const out: Rejection[] = [];
  p.placement.required.forEach((shape, i) => {
    const labels = shape.labels === "any" ? [] : shape.labels;
    const mode = CONFIDENTIALITY_MODES.find((m) => m === shape.confidentiality);
    if (shape.confidentiality !== "any" && mode === undefined) {
      out.push({
        item: "placement",
        path: `placement.required[${i}].confidentiality`,
        reason: `unknown confidentiality mode ${shape.confidentiality}`,
      });
      return;
    }
    for (const c of p.classes) {
      if (!matches(shape, c.name, labels)) continue;
      if (p.placement.unreachable.some((u) => matches(u, c.name, labels))) continue;
      const request = {
        class: c.name,
        labels,
        ...(mode === undefined ? {} : { confidentiality: mode }),
        deviceLocalInput: shape.reachability === "device-local",
      };
      if (eligibleKinds(p, request).kinds.length === 0)
        out.push({
          item: "placement",
          path: `placement.required[${i}]`,
          reason: `required placement unplaceable for class ${c.name}`,
        });
    }
  });
  return out;
};

/** A production deployment keeps FD-PROF-052: a key from the enclave, accepted by the attestation verifier. */
const registration = (p: Profile, deployment: Deployment): Rejection[] => {
  if (deployment === "development") return [];
  const stores = p.registration.key_stores;
  return [
    ...(stores.length === 1 && stores[0] === "secure-enclave"
      ? []
      : [
          {
            item: "registration",
            path: "registration.key_stores",
            reason: "a production deployment admits only secure-enclave keys",
          },
        ]),
    ...(p.registration.attestation === "verifier"
      ? []
      : [
          {
            item: "registration",
            path: "registration.attestation",
            reason: "a production deployment requires the attestation verifier",
          },
        ]),
  ];
};

const context = (p: Profile, c: ValidationContext): Rejection[] =>
  validateProfileContext({
    adapter: p.host.adapter,
    classes: p.classes.map(({ name, guaranteed, cloud_kinds }) => ({
      name,
      guaranteed,
      cloud_kinds: [...cloud_kinds],
    })),
    host_features: [...p.host.features],
    launcher_kinds: [...p.placement.launcher_kinds],
    cloud_pinned_kinds: [...p.placement.cloud_pinned_kinds],
    pools: p.pools.map((pool) => ({
      name: pool.name,
      classes: pool.classes.map((cap) => cap.class),
      minimums: Object.fromEntries(pool.classes.map((cap) => [cap.class, cap.min])),
    })),
    declared_pools: c.declaredPools,
    runs: c.runs,
  }).map(({ path, reason }) => ({ item: path.split(".")[0] ?? path, path, reason }));

/** Every terminal failure reason and acceptance-check reason kind is built in or declared (MAMEKO-PROF-032). */
const reasonKinds = (p: Profile): Rejection[] =>
  validateReasonKinds({
    declared: p.reason_kinds ?? {},
    terminalReasons: Object.fromEntries(
      p.classes.flatMap((c) =>
        typeof c.terminal_outcome === "object" ? [[c.name, c.terminal_outcome.reason]] : [],
      ),
    ),
    acceptanceKinds: acceptanceReasonKinds,
  }).map(({ path, reason }) => ({ item: "reason_kinds", path, reason }));

/** Every rejection the profile validator finds in a decoded document; empty means accepted. */
export const validateProfile = (p: Profile, c: ValidationContext): readonly Rejection[] => [
  ...validateProjected(
    withDefaults(projectProfile(p, { emittedKinds: c.emittedKinds, lines: linesOf(p, c.spend) })),
    c.bindings,
  ),
  ...context(p, c),
  ...classes(p),
  ...intentKinds(p),
  ...placement(p),
  ...reasonKinds(p),
  ...registration(p, c.deployment),
];

/**
 * mameko's loader over the strict `decodeProfile` and this validator. It keeps the accepted snapshot through a
 * rejection (MAMEKO-PROF-004) and rejects a reused policy version with different content (MAMEKO-PROF-007).
 */
export const profileLoader = (c: ValidationContext): ProfileLoader<Profile> =>
  new ProfileLoader<Profile>({
    decode: (raw) =>
      Match.value(decodeProfile(raw)).pipe(
        Match.tag("Accepted", ({ profile }) => ({ ok: true as const, value: profile })),
        Match.tag("Rejected", ({ error }) => ({
          ok: false as const,
          rejections: [{ item: "document", path: "", reason: error }],
        })),
        Match.exhaustive,
      ),
    validate: (doc) => validateProfile(doc, c),
  });

const isVersioned = Schema.is(Schema.Struct({ policy_version: Schema.String }));

/**
 * Delivers the document a configuration source supplies to the loader and answers the accepted profile. The
 * document's `policy_version` must equal the envelope's, which mameko's loader does not compare. Nothing in the
 * document takes effect before every check passes.
 */
export const loadProfile = (
  loader: ProfileLoader<Profile>,
  { document, policyVersion }: ProfileDocument,
) =>
  Effect.gen(function* () {
    const refuse = (rejections: readonly Rejection[]) =>
      Effect.fail(new ProfileRejected({ policy_version: policyVersion, rejections }));
    if (isVersioned(document) && document.policy_version !== policyVersion)
      return yield* refuse([
        {
          item: "document",
          path: "policy_version",
          reason: `the document's policy version differs from the delivered ${policyVersion}`,
        },
      ]);
    return yield* Match.value(loader.deliver({ document, policyVersion })).pipe(
      Match.tag("Accepted", () => Effect.sync(() => loader.begin().document)),
      Match.tag("Rejected", ({ rejections }) => refuse(rejections)),
      Match.exhaustive,
    );
  });
