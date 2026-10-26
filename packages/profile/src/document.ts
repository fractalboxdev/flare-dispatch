// FlareDispatch's profile document: the values of specs/qos-admission.md,
// specs/github-output.md, specs/placement-leases.md and specs/spend.md, in the
// form of mameko's reference CI profile (mameko specs/profiles.md § The
// reference CI profile). Where the two disagree, the reference profile's value
// stands here.
//
// The document is plain data so the configuration source can deliver it as
// one; `loadProfile` decodes and validates it before any value takes effect.
import { ConfigurationSource, type ProfileDocument } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import type { Predicate, Profile } from "./schema.ts";

/** P0 to P3. `cloud-pinned` keeps `release` off devices; `required` is the one firm class. */
const classes: Profile["classes"] = [
  {
    name: "release",
    rank: 0,
    claim_deadline: "none",
    cloud_kinds: ["cloudflare", "gha"],
    line: "budget",
    guaranteed: true,
    terminal_outcome: { outcome: "failure", reason: "budget: release reserve exhausted" },
    reserve: "release-reserve",
    queue_age: "run",
    bounds: { global: 16, per_scope: 8 },
    sheddable: false,
    retries: "run",
    queue_full_alarm: "p0-breach",
  },
  {
    name: "required",
    rank: 1,
    claim_deadline: { seconds: 60 },
    cloud_kinds: ["cloudflare", "aws", "gha"],
    line: "next-above-less-reserve",
    guaranteed: true,
    firm: true,
    terminal_outcome: { outcome: "failure", reason: "budget: required reserve exhausted" },
    reserve: "measured",
    queue_age: "run",
    bounds: { global: 150, per_scope: 60 },
    sheddable: false,
    retries: 1,
  },
  {
    name: "interactive",
    rank: 2,
    claim_deadline: { seconds: 300 },
    cloud_kinds: ["cloudflare", "gha"],
    line: "next-above-less-reserve",
    guaranteed: true,
    terminal_outcome: { outcome: "failure", reason: "budget" },
    queue_age: { seconds: 1800 },
    bounds: { global: 40, per_scope: 10 },
    sheddable: true,
    retries: 1,
  },
  {
    name: "batch",
    rank: 3,
    claim_deadline: "staleness",
    cloud_kinds: ["cloudflare", "gha"],
    line: { general_band_ratio: 0.45, floor_ratio: 0.1 },
    guaranteed: true,
    terminal_outcome: "deferred",
    queue_age: "staleness",
    bounds: { global: 30, per_run_scope: 1 },
    sheddable: true,
    retries: "local-only",
    stale_after: { fraction: 0.5, without_schedule_seconds: 43_200 },
  },
];

const checkRunMarker = "external_id equal to the execution id; updates are idempotent";
const bodyMarker = "<!-- flare-dispatch:intent <execution_id>/<intent_key> -->";

/**
 * Every kind the control plane accepts. The four check kinds are the check-run lifecycle: `check.open` at
 * admission, `check.start` per lease grant, `check.progress` while waiting and `check.conclude` with the outcome,
 * applied in insertion order per execution.
 */
const intent_kinds: Profile["intent_kinds"] = {
  "check.open": {
    origin: "control-plane",
    on: "admitted",
    payload: "checkOpenPayload",
    delivery_tier: "effect",
    applied_for: "any",
    draws_reserve: true,
    priority: 0,
    opens_surface: true,
    in_order: true,
    effect_class: "adoptable",
    applier: "checkRun",
    marker: checkRunMarker,
  },
  "check.start": {
    origin: "control-plane",
    on: "lease-granted",
    payload: "checkStartPayload",
    delivery_tier: "effect",
    applied_for: "any",
    priority: 1,
    void_after_outcome: true,
    in_order: true,
    effect_class: "adoptable",
    applier: "checkRun",
    marker: checkRunMarker,
  },
  // Generated at each step and placement-state change; one coalescing key per execution, so a newer row voids
  // the older pending ones and only the latest position applies (FD-GH-012).
  "check.progress": {
    origin: "control-plane",
    on: "progress",
    payload: "checkProgressPayload",
    coalesce_key: "executionProgressKey",
    delivery_tier: "progress",
    applied_for: "any",
    void_after_outcome: true,
    in_order: true,
    effect_class: "adoptable",
    applier: "checkRun",
    marker: checkRunMarker,
  },
  "check.conclude": {
    origin: "control-plane",
    delivery_tier: "outcome",
    applied_for: "any",
    in_order: true,
    effect_class: "adoptable",
    applier: "checkRun",
    marker: checkRunMarker,
  },
  "check.summary": {
    origin: "run",
    delivery_tier: "effect",
    applied_for: "any",
    priority: 2,
    effect_class: "adoptable",
    applier: "checkRun",
    marker: "the check run found by external_id",
  },
  "check.annotations": {
    origin: "run",
    delivery_tier: "effect",
    applied_for: "any",
    priority: 2,
    effect_class: "adoptable",
    applier: "checkRun",
    marker: "annotations read back by check-run id",
  },
  comment: {
    origin: "run",
    delivery_tier: "effect",
    applied_for: "any",
    priority: 2,
    effect_class: "adoptable",
    applier: "issueComment",
    marker: bodyMarker,
  },
  review: {
    origin: "run",
    delivery_tier: "effect",
    applied_for: "any",
    priority: 2,
    effect_class: "adoptable",
    applier: "pullReview",
    marker: bodyMarker,
  },
  issue: {
    origin: "run",
    delivery_tier: "effect",
    applied_for: "any",
    priority: 2,
    effect_class: "adoptable",
    applier: "issue",
    marker: bodyMarker,
  },
  "pr.propose": {
    origin: "control-plane",
    on: "accepted",
    payload: "prProposePayload",
    delivery_tier: "effect",
    applied_for: ["success"],
    priority: 2,
    effect_class: "adoptable",
    applier: "pullRequest",
    marker: "the head branch name",
  },
  "release.draft": {
    origin: "run",
    delivery_tier: "effect",
    applied_for: ["success"],
    priority: 2,
    effect_class: "adoptable",
    applier: "release",
    marker: "the tag name",
  },
  "release.publish": {
    origin: "run",
    delivery_tier: "effect",
    applied_for: ["success"],
    priority: 2,
    effect_class: "adoptable",
    applier: "release",
    marker: "the tag name",
  },
  "canary.push": {
    origin: "control-plane",
    delivery_tier: "effect",
    applied_for: "any",
    priority: 2,
    ops: true,
    effect_class: "adoptable",
    applier: "canary",
    marker: "the tick time in the commit message",
  },
  "delivery.redeliver": {
    origin: "control-plane",
    delivery_tier: "effect",
    applied_for: "any",
    priority: 2,
    ops: true,
    effect_class: "adoptable",
    applier: "webhookRedelivery",
    marker: "the delivery's attempts, read back before a repeat",
  },
  label: {
    origin: "run",
    delivery_tier: "effect",
    applied_for: "any",
    priority: 2,
    effect_class: "replay-safe",
    applier: "labels",
  },
  "pr.close": {
    origin: "run",
    delivery_tier: "effect",
    applied_for: "any",
    priority: 2,
    effect_class: "replay-safe",
    applier: "pullRequest",
  },
  "dispatch.followOn": {
    origin: "run",
    delivery_tier: "effect",
    applied_for: "any",
    priority: 2,
    effect_class: "replay-safe",
    applier: "followOn",
  },
  "notify.email": {
    origin: "both",
    delivery_tier: "effect",
    applied_for: "any",
    priority: 2,
    effect_class: "replay-safe",
    applier: "notifyEmail",
  },
  "notify.slack": {
    origin: "both",
    delivery_tier: "effect",
    applied_for: "any",
    priority: 2,
    effect_class: "replay-safe",
    applier: "notifySlack",
  },
  "notice.publish": {
    origin: "both",
    delivery_tier: "effect",
    applied_for: "any",
    priority: 2,
    effect_class: "replay-safe",
    applier: "notice",
  },
};

const label = (name: string): Predicate => ({ label: name });
const isClass = (name: string): Predicate => ({ class: name });
const not = (predicate: Predicate): Predicate => ({ not: predicate });
const all = (...predicates: Predicate[]): Predicate => ({ all: predicates });
const anyShape = {
  class: "any",
  labels: "any",
  confidentiality: "any",
  reachability: "any",
} as const;
const withLabels = (...labels: string[]) => ({ ...anyShape, labels });

/**
 * The generic constraints' parameters, the `gha` launcher and five declared constraints. Every class lists `gha`
 * last, so a macOS release-matrix job of any class keeps `gha`; the constraints remove `gha` from every other run.
 */
const placement: Profile["placement"] = {
  cloud_pinned: all(isClass("release"), not(label("release-matrix"))),
  cloud_only: { trigger: "tag-push" },
  local_only: { undeclared_class: true },
  cloud_pinned_kinds: ["cloudflare"],
  launcher_kinds: ["gha"],
  constraints: [
    {
      name: "release-matrix",
      holds_for: label("release-matrix"),
      removes: ["cloudflare", "aws", "device"],
    },
    { name: "apple-build", holds_for: label("apple-build"), removes: ["cloudflare", "aws"] },
    {
      name: "apple-build-gha",
      holds_for: all(label("apple-build"), not(isClass("required")), not(label("release-matrix"))),
      removes: ["gha"],
    },
    {
      name: "gha-apple-only",
      holds_for: all(not(label("apple-build")), not(label("release-matrix"))),
      removes: ["gha"],
    },
    {
      name: "reproduction",
      holds_for: label("reproduction"),
      removes: ["cloudflare", "aws", "gha"],
      requires_posture: "attested-dedicated",
    },
  ],
  required: [withLabels("release-matrix")],
  unreachable: [
    withLabels("reproduction", "untrusted-input"),
    withLabels("reproduction", "cloud-only"),
    withLabels("reproduction", "expose-port"),
    withLabels("apple-build", "expose-port"),
  ],
};

const cap = (cls: string, max: number, min = 0) => ({ class: cls, max, min });

/** The failure categories of mameko's closed outcome union; each concludes `failure` with its reason. */
const FAILURE_CATEGORIES = [
  "finding",
  "infra",
  "budget",
  "capacity",
  "deadline",
  "halt",
  "placement",
  "unrecorded",
  "config",
  "policy",
] as const;
const CANCEL_CAUSES = [
  "superseded",
  "parent-ended",
  "operator-cancel",
  "pr-closed",
  "merge-group-destroyed",
] as const;

export const profile: Profile = {
  policy_version: "flare-dispatch.v2.0",
  classes,
  /**
   * Per-class caps inside each Container pool's admission cap (FD-PROF-032); the admission caps themselves (`lean`
   * 48, `agent` 8, `browser` 16, `release` 8, `control` 16) are the runtime adapter's configuration.
   */
  // TODO(maintainer): FD-PROF-032 keeps 2 slots for P0 and P1 together; a floor over a group of classes waits on
  // mameko specs/profiles.md § Open items, so `min: 2` sits on `required` alone.
  pools: [
    { name: "lean", classes: [cap("batch", 4), cap("interactive", 8)] },
    { name: "agent", classes: [cap("batch", 6), cap("interactive", 6), cap("required", 8, 2)] },
    { name: "browser", classes: [cap("batch", 4), cap("interactive", 10), cap("required", 16, 2)] },
    { name: "release", classes: [], reserved_for: "release" },
    { name: "control", classes: [] },
  ],
  /** FD-PROF-034. */
  browser_sessions: {
    cap: 10,
    classes: [cap("batch", 1), cap("interactive", 2), cap("required", 10, 1)],
  },
  class_resolution: {
    binding: "resolveClass",
    inputs: [{ name: "protection-snapshot" }, { name: "policy-rules" }],
    default_class: "batch",
  },
  supersession_key: "supersessionKey",
  member_partition: true,
  dedup_recipes: [
    { name: "idempotency-key", binding: "idempotencyKeyRecipe" },
    { name: "follow-on", binding: "followOnRecipe" },
    { name: "commit", binding: "commitRecipe", total: true },
  ],
  outcome_mapping: {
    surface_values: ["success", "failure", "cancelled", "neutral"],
    silent_values: ["neutral"],
    by_outcome: {
      success: "success",
      ...Object.fromEntries(FAILURE_CATEGORIES.map((c) => [c, "failure"])),
      ...Object.fromEntries(CANCEL_CAUSES.map((c) => [c, "cancelled"])),
      "skipped-listed": "neutral",
      "skipped-other": "failure",
      deferred: { opened: "failure", unopened: "none" },
      expired: "failure",
    },
    surface_kind: "check.conclude",
    not_applicable_details: [
      "draft-pr",
      "author-excluded",
      "path-filter",
      "not-configured",
      "nothing-to-lint",
      "every-job-skipped",
      "empty-range",
    ],
    cancel_causes: ["pr-closed", "merge-group-destroyed"],
  },
  reclaim_policy: {
    release: "restart",
    required: "restart",
    interactive: "restart",
    batch: "restart",
  },
  intent_kinds,
  delivery: {
    limit_key: "installationOf",
    ops_class: "required",
    undelivered_alarm: "undelivered-verdict",
  },
  /** FD-PROF-048. No kind is gated, so no key. */
  gate_policy: { keys: [], max_expiry_seconds: 86_400 },
  /** mameko's default list plus FlareDispatch's release surface. */
  approval_floor: [
    { program: "git", subcommands: ["push"] },
    { program: "npm", subcommands: ["publish"] },
    { program: "pnpm", subcommands: ["publish"] },
    { program: "yarn", subcommands: ["publish"] },
    { program: "cargo", subcommands: ["publish"] },
    { program: "wrangler", subcommands: ["deploy"] },
    { program: "terraform", subcommands: ["apply"] },
    { program: "kubectl", subcommands: ["apply"] },
    { program: "kubectl", subcommands: ["delete"] },
    { program: "terraform", subcommands: ["destroy"] },
    { program: "wrangler", subcommands: ["secret"] },
    { program: "iptables", subcommands: [] },
    { program: "nft", subcommands: [] },
    { program: "pfctl", subcommands: [] },
    { program: "networksetup", subcommands: [] },
    { program: "wrangler", subcommands: ["d1"] },
    { program: "gh", subcommands: ["release"] },
  ],
  egress_profiles: {
    setup: { grants: ["package-registries", "git-remote"], other_hosts: "declared-methods" },
    agent: { grants: ["model-gateway", "git-remote"], other_hosts: "read-only" },
  },
  signing_purposes: ["statement", "cache-entry"],
  placement,
  cache_namespaces: "cacheNamespaces",
  capacity: { grant: "capacityGrant" },
  registration: { key_stores: ["secure-enclave"], attestation: "verifier" },
  host: {
    adapter: "host-cloudflare",
    features: ["cloudflare-containers", "durable-object-alarms"],
  },
  /**
   * The result-acceptance check rejects a result with `provenance: <check>`, and the execution concludes `failure`
   * with that reason (MAMEKO-LEASE-090).
   */
  reason_kinds: { provenance: "policy" },
};

/** The result-acceptance check's reason kinds, which MAMEKO-PROF-032 requires the profile to declare. */
export const acceptanceReasonKinds: readonly string[] = ["provenance"];

/** The profile as the configuration source delivers it: the document and its policy version. */
export const profileDocument: ProfileDocument = {
  document: profile,
  policyVersion: profile.policy_version,
};

/** FlareDispatch's configuration source: the committed profile, one document at one policy version. */
export const ConfigurationSourceLive = Layer.succeed(ConfigurationSource, {
  load: Effect.succeed(profileDocument),
});

/**
 * Per-device slot defaults for an 8-slot share. mameko keeps these on the executor's registry row, not in the
 * profile; each device's row may replace them (FD-PROF-035, FD-PROF-036).
 */
export const deviceSlotDefaults = {
  total: 8,
  /** Kept free for `required`, the highest-rank device class. */
  headroom: 2,
  claim_caps: { interactive: 3, batch: 5, interactive_and_batch: 6 },
} as const;

/**
 * Spend amounts the class `reserve` and `line` fields name, in micro-USD, with FlareDispatch's defaults; the
 * operator overlay replaces each (FD-PROF-054).
 */
export const spendDefaults = {
  budget: 50_000_000,
  fixed: 0,
  reserves: { "release-reserve": 10_000_000 },
  ops_reserve: 5_000_000,
  measured_reserve_min: 20_000_000,
  measured_reserve_days: 10,
  overhead_factor: 1.1,
} as const;
