// The checks of mameko specs/profiles.md § Profile validator that read only
// the items this package declares. The validator is pure and reports every
// rejection. The checks that need bindings registered in code, scope
// manifests or run volumes belong to the coordinator's validator.
import { validateRuntimeFeatures } from "@fractalboxdev/mameko-kernel";
import type { ProfileDocument } from "@fractalboxdev/mameko-ports";
import { Effect, Schema } from "effect";
import { eligibleKinds } from "./placement.ts";
import { Profile, ProfileRejected, type PlacementShape, type Rejection } from "./schema.ts";

const BUILT_IN_CLOUD_KINDS = ["cloudflare", "aws"] as const;

const ranks = (p: Profile): Rejection[] => {
  const sorted = p.classes.map((c) => c.rank).sort((a, b) => a - b);
  return sorted.every((r, i) => r === i)
    ? []
    : [
        {
          item: "classes",
          path: "classes[].rank",
          reason: "no highest-rank class: ranks must be 0..n-1, each once",
        },
      ];
};

const classes = (p: Profile): Rejection[] => {
  const cloudKinds = new Set<string>([...BUILT_IN_CLOUD_KINDS, ...p.placement.launcher_kinds]);
  const lowest = Math.max(...p.classes.map((c) => c.rank));
  const measured = p.classes.filter((c) => c.reserve === "measured");
  const out: Rejection[] = [];
  for (const c of p.classes) {
    const path = `classes[${c.name}]`;
    if (!c.guaranteed && (c.cloud_kinds.length > 0 || c.firm === true))
      out.push({ item: "classes", path, reason: "guaranteed flag disagrees with the cloud kinds" });
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
  if (measured.length !== 1 || measured.some((c) => c.rank === lowest))
    out.push({
      item: "classes",
      path: "classes[].reserve",
      reason: "exactly one class, not the lowest rank, declares reserve: measured",
    });
  return out;
};

const intentKinds = (p: Profile): Rejection[] => {
  const out: Rejection[] = [];
  const classNames = new Set(p.classes.map((c) => c.name));
  for (const [kind, k] of Object.entries(p.intent_kinds)) {
    const path = `intent_kinds.${kind}`;
    if (k.origin === "run" && k.on !== undefined)
      out.push({
        item: "intent_kinds",
        path: `${path}.on`,
        reason: "a run kind declares no lifecycle trigger",
      });
    if (
      (k.on === "admitted" || k.on === "lease-granted" || k.on === "accepted") &&
      k.payload === undefined
    )
      out.push({
        item: "intent_kinds",
        path: `${path}.payload`,
        reason: "lifecycle kind without a payload",
      });
    if (k.ops === true && k.applied_for !== "any")
      out.push({
        item: "intent_kinds",
        path: `${path}.applied_for`,
        reason: "an ops kind applies for any outcome",
      });
    if (
      k.ops === true &&
      (p.delivery.ops_class === undefined || !classNames.has(p.delivery.ops_class))
    )
      out.push({
        item: "delivery",
        path: "delivery.ops_class",
        reason: `ops kind ${kind} without an ops class`,
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

/** Every `placement.required` shape must leave a non-empty eligible set at every class it covers. */
const placement = (p: Profile): Rejection[] => {
  const known = new Set<string>([...BUILT_IN_CLOUD_KINDS, ...p.placement.launcher_kinds]);
  const out: Rejection[] = p.placement.cloud_pinned_kinds
    .filter((k) => !known.has(k))
    .map((k) => ({
      item: "placement",
      path: "placement.cloud_pinned_kinds",
      reason: `unknown cloud kind ${k}`,
    }));
  p.placement.required.forEach((shape, i) => {
    const labels = shape.labels === "any" ? [] : shape.labels;
    for (const c of p.classes) {
      if (!matches(shape, c.name, labels)) continue;
      if (p.placement.unreachable.some((u) => matches(u, c.name, labels))) continue;
      const request = {
        class: c.name,
        labels,
        ...(shape.confidentiality === "any" ? {} : { confidentiality: shape.confidentiality }),
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

const runtime = (p: Profile): Rejection[] =>
  validateRuntimeFeatures(p.host.adapter, {
    features: p.host.features,
    cloudKinds: p.classes.flatMap((c) => c.cloud_kinds),
  }).map(({ feature, adapter }) => ({
    item: "host",
    path: "host.features",
    reason: `runtime-specific feature ${feature} is outside ${adapter}`,
  }));

/** Every rejection the profile validator finds in a decoded document; empty means accepted. */
export const validateProfile = (p: Profile): readonly Rejection[] => [
  ...ranks(p),
  ...classes(p),
  ...intentKinds(p),
  ...placement(p),
  ...runtime(p),
];

const decode = Schema.decodeUnknownEffect(Profile, { onExcessProperty: "error" });

const rejected = (policyVersion: string, rejections: readonly Rejection[]) =>
  new ProfileRejected({ policy_version: policyVersion, rejections });

/**
 * Decodes the document a configuration source delivers with excess properties rejected, then validates it. A
 * failing decode names its first failing path; a failing validation lists every rejection. The document's
 * `policy_version` must equal the envelope's. Nothing in the document takes effect before every check passes.
 */
export const loadProfile = ({ document, policyVersion }: ProfileDocument) =>
  Effect.gen(function* () {
    const doc = yield* decode(document).pipe(
      Effect.mapError((e) =>
        rejected(policyVersion, [{ item: "document", path: "", reason: e.message }]),
      ),
    );
    const rejections: readonly Rejection[] = [
      ...(doc.policy_version === policyVersion
        ? []
        : [
            {
              item: "document",
              path: "policy_version",
              reason: `the document's policy version differs from the delivered ${policyVersion}`,
            },
          ]),
      ...validateProfile(doc),
    ];
    if (rejections.length > 0) return yield* Effect.fail(rejected(policyVersion, rejections));
    return doc;
  });
