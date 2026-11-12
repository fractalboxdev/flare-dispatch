// mameko's reference CI profile at the pinned commit (mameko specs/profiles.md § The reference CI profile), as the
// values its prose states, and the comparison FD-PROF-002 and the `profile-reference` job (FD-VER-033) run against
// FlareDispatch's production document. Values the prose leaves to "the reference application's own profile instance"
// are absent from the fixture and outside the comparison.
import type { Phase } from "./document.ts";
import type { Profile } from "./schema.ts";

/** A JSON value the comparison walks. */
type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };

const MAMEKO_DEFAULT_FLOOR = [
  "git push",
  "npm publish",
  "pnpm publish",
  "yarn publish",
  "cargo publish",
  "wrangler deploy",
  "terraform apply",
  "kubectl apply",
  "kubectl delete",
  "terraform destroy",
  "wrangler secret",
  "iptables",
  "nft",
  "pfctl",
  "networksetup",
];

const checkMarker = "external_id equal to the execution id; updates are idempotent";

/** Every value the reference profile's prose states, keyed as the comparison keys FlareDispatch's document. */
export const referenceProfile: { readonly [k: string]: Json } = {
  classes: {
    release: {
      rank: 0,
      claim_deadline: "none",
      cloud_kinds: ["cloudflare", "gha"],
      line: "budget",
      guaranteed: true,
      terminal_outcome: { outcome: "failure", reason: "budget: release reserve exhausted" },
      queue_age: "run",
      sheddable: false,
      retries: "run",
      queue_full_alarm: "p0-breach",
    },
    required: {
      rank: 1,
      claim_deadline: { seconds: 60 },
      cloud_kinds: ["cloudflare", "aws", "gha"],
      line: "next-above-less-reserve",
      guaranteed: true,
      firm: true,
      terminal_outcome: { outcome: "failure", reason: "budget: required reserve exhausted" },
      reserve: "measured",
      queue_age: "run",
      sheddable: false,
      retries: 1,
    },
    interactive: {
      rank: 2,
      claim_deadline: { seconds: 300 },
      cloud_kinds: ["cloudflare", "gha"],
      line: "next-above-less-reserve",
      guaranteed: true,
      terminal_outcome: { outcome: "failure", reason: "budget" },
      queue_age: { seconds: 1800 },
      sheddable: true,
      retries: 1,
    },
    batch: {
      rank: 3,
      claim_deadline: "staleness",
      cloud_kinds: ["cloudflare", "gha"],
      guaranteed: true,
      terminal_outcome: "deferred",
      queue_age: "staleness",
      sheddable: true,
      retries: "local-only",
      stale_after: { fraction: 0.5, without_schedule_seconds: 43_200 },
    },
  },
  pool_names: ["lean", "agent", "browser", "release", "control"],
  release_pool_reserved_for: "release",
  browser_session_caps: { batch: 1, interactive: 2, required_min: 1 },
  member_partition: true,
  supersession_key: "present",
  cache_namespaces: "present",
  capacity_grant: "present",
  registration: { key_stores: ["secure-enclave"], attestation: "verifier" },
  class_resolution: {
    binding: "resolveClass",
    inputs: ["protection-snapshot", "policy-rules"],
    default_class: "batch",
  },
  dedup_recipes: [
    { name: "idempotency-key", total: false, on_mismatch: "duplicate", digest: "absent" },
    { name: "follow-on", total: false, on_mismatch: "duplicate", digest: "absent" },
    { name: "commit", total: true, on_mismatch: "duplicate", digest: "absent" },
  ],
  reclaim_policy: {
    release: "restart",
    required: "restart",
    interactive: "restart",
    batch: "restart",
  },
  outcome_mapping: {
    surface_values: ["success", "failure", "cancelled", "neutral"],
    silent_values: ["neutral"],
    surface_kind: "check.conclude",
    skipped_listed: "neutral",
    skipped_other: "failure",
    deferred: { opened: "failure", unopened: "none" },
    expired: "failure",
    capacity_outcomes: {
      budget: "failure",
      capacity: "failure",
      deadline: "failure",
      halt: "failure",
      placement: "failure",
    },
    not_applicable_details: [
      "draft-pr",
      "author-excluded",
      "path-filter",
      "not-configured",
      "nothing-to-lint",
      "every-job-skipped",
      "empty-range",
    ],
    app_cancel_causes: ["merge-group-destroyed", "pr-closed"],
  },
  intent_kinds: {
    "check.open": kind("control-plane", "adoptable", "effect", "any", checkMarker, {
      on: "admitted",
      opens_surface: true,
      draws_reserve: true,
      in_order: true,
      priority: 0,
    }),
    "check.start": kind("control-plane", "adoptable", "effect", "any", checkMarker, {
      on: "lease-granted",
      void_after_outcome: true,
      in_order: true,
      priority: 1,
    }),
    "check.progress": kind("control-plane", "adoptable", "progress", "any", checkMarker, {
      void_after_outcome: true,
      in_order: true,
    }),
    "check.conclude": kind("control-plane", "adoptable", "outcome", "any", checkMarker, {
      in_order: true,
    }),
    "check.summary": kind(
      "run",
      "adoptable",
      "effect",
      "any",
      "the check run found by external_id",
    ),
    "check.annotations": kind(
      "run",
      "adoptable",
      "effect",
      "any",
      "annotations read back by check-run id",
    ),
    comment: kind(
      "run",
      "adoptable",
      "effect",
      "any",
      "<!-- ci:intent <execution_id>/<intent_key> -->",
    ),
    review: kind(
      "run",
      "adoptable",
      "effect",
      "any",
      "<!-- ci:intent <execution_id>/<intent_key> -->",
    ),
    issue: kind(
      "run",
      "adoptable",
      "effect",
      "any",
      "<!-- ci:intent <execution_id>/<intent_key> -->",
    ),
    "pr.propose": kind(
      "control-plane",
      "adoptable",
      "effect",
      ["success"],
      "the head branch name",
      {
        on: "accepted",
      },
    ),
    "release.draft": kind("run", "adoptable", "effect", ["success"], "the tag name"),
    "release.publish": kind("run", "adoptable", "effect", ["success"], "the tag name"),
    "canary.push": kind(
      "control-plane",
      "adoptable",
      "effect",
      "any",
      "the tick time in the commit message",
      { ops: true },
    ),
    "delivery.redeliver": kind(
      "control-plane",
      "adoptable",
      "effect",
      "any",
      "the delivery's attempts, read back before a repeat",
      { ops: true },
    ),
    label: kind("run", "replay-safe", "effect", "any", null),
    "pr.close": kind("run", "replay-safe", "effect", "any", null),
    "dispatch.followOn": kind("run", "replay-safe", "effect", "any", null),
    "notify.email": kind("both", "replay-safe", "effect", "any", null),
    "notify.slack": kind("both", "replay-safe", "effect", "any", null),
    "notice.publish": kind("both", "replay-safe", "effect", "any", null),
  },
  delivery: { ops_class: "required", undelivered_alarm: "undelivered-verdict" },
  gate_policy_keys: [],
  approval_floor: [...MAMEKO_DEFAULT_FLOOR, "gh release", "wrangler d1"].sort(),
  egress_profiles: {
    setup: { grants: ["git-remote", "package-registries"], other_hosts: "declared-methods" },
    agent: { grants: ["git-remote", "model-gateway"], other_hosts: "read-only" },
  },
  signing_purposes: ["cache-entry", "statement"],
  placement: {
    cloud_pinned: { all: [{ class: "release" }, { not: { label: "release-matrix" } }] },
    cloud_only: { trigger: "tag-push" },
    local_only: { undeclared_class: true },
    cloud_pinned_kinds: ["cloudflare"],
    launcher_kinds: ["gha"],
    constraints: {
      "release-matrix": { removes: ["aws", "cloudflare", "device"], requires_posture: "none" },
      "apple-build": { removes: ["aws", "cloudflare"], requires_posture: "none" },
      "apple-build-gha": { removes: ["gha"], requires_posture: "none" },
      "gha-apple-only": { removes: ["gha"], requires_posture: "none" },
      reproduction: {
        removes: ["aws", "cloudflare", "gha"],
        requires_posture: "attested-dedicated",
      },
    },
    required_labels: [["release-matrix"]],
  },
  host: {
    adapter: "host-cloudflare",
    features: ["cloudflare-containers", "durable-object-alarms"],
  },
  reason_kinds: {},
  class_isolation: {},
};

function kind(
  origin: string,
  effect_class: string,
  delivery_tier: string,
  applied_for: Json,
  marker: string | null,
  flags: Readonly<Record<string, Json>> = {},
): Json {
  return {
    origin,
    effect_class,
    delivery_tier,
    applied_for,
    marker: marker ?? "none",
    on: "none",
    opens_surface: false,
    draws_reserve: false,
    void_after_outcome: false,
    in_order: false,
    ops: false,
    gated: false,
    // Within the `effect` tier `check.open` has priority 0, `check.start` 1 and every other kind 2.
    ...(delivery_tier === "effect" ? { priority: 2 } : {}),
    ...flags,
  };
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

/** FlareDispatch's document projected onto the reference's keys. */
export const projectForReference = (p: Profile): { readonly [k: string]: Json } => {
  const browser = Object.fromEntries(p.browser_sessions.classes.map((c) => [c.class, c] as const));
  const tierPriority = (k: Profile["intent_kinds"][string]): Json =>
    k.delivery_tier === "effect" ? { priority: k.priority ?? 2 } : {};
  return {
    classes: Object.fromEntries(
      p.classes.map((c) => {
        const { name: _name, bounds: _bounds, reserve, line, isolation: _iso, ...rest } = c;
        return [
          c.name,
          {
            ...(rest as unknown as { [k: string]: Json }),
            ...(c.name === "release" || reserve === undefined ? {} : { reserve }),
            ...(typeof line === "string" ? { line } : {}),
          },
        ];
      }),
    ),
    pool_names: p.pools.map((x) => x.name),
    release_pool_reserved_for: p.pools.find((x) => x.name === "release")?.reserved_for ?? "none",
    browser_session_caps: {
      batch: browser["batch"]?.max ?? 0,
      interactive: browser["interactive"]?.max ?? 0,
      required_min: browser["required"]?.min ?? 0,
    },
    member_partition: p.member_partition ?? false,
    supersession_key: p.supersession_key === undefined ? "absent" : "present",
    cache_namespaces: p.cache_namespaces === undefined ? "absent" : "present",
    capacity_grant: p.capacity?.grant === undefined ? "absent" : "present",
    registration: {
      key_stores: [...p.registration.key_stores],
      attestation: p.registration.attestation,
    },
    class_resolution: {
      binding: p.class_resolution.binding,
      inputs: p.class_resolution.inputs.map((i) => i.name),
      default_class: p.class_resolution.default_class,
    },
    dedup_recipes: p.dedup_recipes.map((r) => ({
      name: r.name,
      total: r.total ?? false,
      on_mismatch: r.on_mismatch ?? "duplicate",
      digest: r.digest === undefined ? "absent" : "present",
    })),
    reclaim_policy: { ...p.reclaim_policy },
    outcome_mapping: {
      surface_values: [...p.outcome_mapping.surface_values],
      silent_values: [...p.outcome_mapping.silent_values],
      surface_kind: p.outcome_mapping.surface_kind,
      skipped_listed: p.outcome_mapping.by_outcome["skipped-listed"] as Json,
      skipped_other: p.outcome_mapping.by_outcome["skipped-other"] as Json,
      deferred: p.outcome_mapping.by_outcome["deferred"] as Json,
      expired: p.outcome_mapping.by_outcome["expired"] as Json,
      capacity_outcomes: Object.fromEntries(
        ["budget", "capacity", "deadline", "halt", "placement"].map((c) => [
          c,
          p.outcome_mapping.by_outcome[c] as Json,
        ]),
      ),
      not_applicable_details: [...p.outcome_mapping.not_applicable_details],
      app_cancel_causes: sorted(p.outcome_mapping.cancel_causes ?? []),
    },
    intent_kinds: Object.fromEntries(
      Object.entries(p.intent_kinds).map(([name, k]) => [
        name,
        {
          origin: k.origin,
          effect_class: k.effect_class,
          delivery_tier: k.delivery_tier,
          applied_for: k.applied_for as Json,
          marker: k.effect_class === "replay-safe" ? "none" : (k.marker ?? "none").toLowerCase(),
          on: k.on === undefined || k.on === "terminal" || k.on === "progress" ? "none" : k.on,
          opens_surface: k.opens_surface ?? false,
          draws_reserve: k.draws_reserve ?? false,
          void_after_outcome: k.void_after_outcome ?? false,
          in_order: k.in_order ?? false,
          ops: k.ops ?? false,
          gated: k.gated ?? false,
          ...(tierPriority(k) as { [k: string]: Json }),
        },
      ]),
    ),
    delivery: {
      ops_class: p.delivery.ops_class ?? "none",
      undelivered_alarm: p.delivery.undelivered_alarm ?? "none",
    },
    gate_policy_keys: [...p.gate_policy.keys],
    approval_floor: sorted(p.approval_floor.map((f) => [f.program, ...f.subcommands].join(" "))),
    egress_profiles: Object.fromEntries(
      Object.entries(p.egress_profiles).map(([name, e]) => [
        name,
        { grants: sorted(e.grants), other_hosts: e.other_hosts },
      ]),
    ),
    signing_purposes: sorted(p.signing_purposes),
    placement: {
      cloud_pinned: p.placement.cloud_pinned as Json,
      cloud_only: p.placement.cloud_only as Json,
      local_only: p.placement.local_only as Json,
      cloud_pinned_kinds: [...p.placement.cloud_pinned_kinds],
      launcher_kinds: [...p.placement.launcher_kinds],
      constraints: Object.fromEntries(
        p.placement.constraints.map((c) => [
          c.name,
          { removes: sorted(c.removes), requires_posture: c.requires_posture ?? "none" },
        ]),
      ),
      required_labels: p.placement.required.map((s) =>
        s.labels === "any" ? [] : sorted(s.labels),
      ),
    },
    host: { adapter: p.host.adapter, features: [...p.host.features] },
    reason_kinds: { ...p.reason_kinds },
    class_isolation: Object.fromEntries(
      p.classes.flatMap((c) => (c.isolation === undefined ? [] : [[c.name, c.isolation]])),
    ),
  };
};

/** One value that differs: the path, the reference's value and FlareDispatch's. */
export interface Difference {
  readonly path: string;
  readonly reference: Json | undefined;
  readonly flareDispatch: Json | undefined;
}

const isObject = (v: Json | undefined): v is { readonly [k: string]: Json } =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every leaf where the two values differ; arrays compare by position. */
export const diffJson = (a: Json | undefined, b: Json | undefined, path = ""): Difference[] => {
  if (isObject(a) && isObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => diffJson(a[k], b[k], path === "" ? k : `${path}.${k}`));
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length)
    return a.flatMap((x, i) => diffJson(x, b[i], `${path}[${i}]`));
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path, reference: a, flareDispatch: b }];
};

/**
 * The differences specs/profile.md § Differences from the reference CI profile lists, as path prefixes. The phase
 * rows hold before the phase that adds the reference's value (FD-PROF-064).
 */
export const listedDifferences = (phase: Phase): readonly string[] => [
  "intent_kinds.comment.marker",
  "intent_kinds.review.marker",
  "intent_kinds.issue.marker",
  "reason_kinds.provenance",
  "dedup_recipes[0].on_mismatch",
  "dedup_recipes[0].digest",
  ...(phase >= 4 ? ["placement.constraints.credentialed-grant"] : []),
  ...(phase < 3 ? ["classes.required.cloud_kinds"] : []),
  ...(phase < 4
    ? [
        "classes.release.cloud_kinds",
        "classes.required.cloud_kinds",
        "classes.interactive.cloud_kinds",
        "classes.batch.cloud_kinds",
        "placement.launcher_kinds",
        "placement.constraints",
        "placement.required_labels",
      ]
    : []),
  ...(phase < 1 ? ["registration.key_stores", "registration.attestation"] : []),
];

const listed = (path: string, prefixes: readonly string[]): boolean =>
  prefixes.some((p) => path === p || path.startsWith(`${p}.`) || path.startsWith(`${p}[`));

/** The comparison of FD-PROF-002: every difference the listed rows do not cover. */
export const unlistedDifferences = (p: Profile, phase: Phase): readonly Difference[] => {
  const allowed = listedDifferences(phase);
  return diffJson(referenceProfile, projectForReference(p)).filter((d) => !listed(d.path, allowed));
};
