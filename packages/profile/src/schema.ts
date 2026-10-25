// The profile items FlareDispatch declares, keyed and bounded as mameko's
// specs/profiles.md states them. mameko's own `Profile` schema belongs to
// `@fractalboxdev/mameko-ports`, which exports nothing yet; until it does, this
// file is the decode boundary for the class catalogue, the reclaim policy, the
// intent kinds, delivery, placement and the runtime adapter.
//
// Two encodings are this package's, because profiles.md fixes their meaning but
// not their shape: a class `line`, and the predicate a placement constraint
// holds for.
import { Schema } from "effect";

const Name = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]*$/),
  Schema.isBetweenLength(1, 32),
);
const AlarmName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]*$/),
  Schema.isBetweenLength(1, 64),
);
/** A binding the application registers in code: an applier, a payload builder, a key function. */
const BindingName = Schema.String.check(
  Schema.isPattern(/^[a-z][A-Za-z0-9-]*$/),
  Schema.isBetweenLength(1, 64),
);
const Seconds = (maximum: number) => Schema.Int.check(Schema.isBetween({ minimum: 1, maximum }));
const Ratio = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: 1, exclusiveMinimum: true }),
);

/** An executor kind: `device`, `cloudflare`, `aws`, or a launcher kind the profile registers. */
export const ExecutorKindName = Name;

// ---------------------------------------------------------------------------
// Class catalogue (profiles.md § Class catalogue)

export const ClaimDeadline = Schema.Union([
  Schema.Literal("none"),
  Schema.Literal("staleness"),
  Schema.Struct({ seconds: Seconds(86_400) }),
]);
export type ClaimDeadline = typeof ClaimDeadline.Type;

/**
 * Where a class stops admitting (mameko specs/spend.md § Budget, reserves and lines): the budget `B` for the
 * highest rank, the next-higher line less that class's reserve, or for the lowest rank a share of the general
 * band `G` with a floor `φ`.
 */
export const Line = Schema.Union([
  Schema.Literal("budget"),
  Schema.Literal("next-above-less-reserve"),
  Schema.Struct({ general_band_ratio: Ratio, floor_ratio: Ratio }),
]);
export type Line = typeof Line.Type;

export const TerminalOutcome = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("failure"), reason: Schema.String }),
  Schema.Literal("deferred"),
  Schema.Literal("expired"),
]);

const Count = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }));

export const ClassEntry = Schema.Struct({
  name: Name,
  rank: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 })),
  claim_deadline: ClaimDeadline,
  cloud_kinds: Schema.Array(ExecutorKindName).check(Schema.isMaxLength(4)),
  line: Line,
  guaranteed: Schema.Boolean,
  firm: Schema.optionalKey(Schema.Boolean),
  device_eligible: Schema.optionalKey(Schema.Boolean),
  terminal_outcome: TerminalOutcome,
  /** `measured`, or the name of a configured amount in the spend configuration; absent is 0. */
  reserve: Schema.optionalKey(Schema.Union([Schema.Literal("measured"), Name])),
  queue_age: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ seconds: Seconds(604_800) }),
      Schema.Literal("run"),
      Schema.Literal("staleness"),
    ]),
  ),
  bounds: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ global: Count, per_scope: Count }),
      Schema.Struct({ global: Count, per_run_scope: Schema.Literal(1) }),
    ]),
  ),
  sheddable: Schema.optionalKey(Schema.Boolean),
  retries: Schema.optionalKey(
    Schema.Union([
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
      Schema.Literal("run"),
      Schema.Literal("local-only"),
    ]),
  ),
  stale_after: Schema.optionalKey(
    Schema.Struct({ fraction: Ratio, without_schedule_seconds: Seconds(604_800) }),
  ),
  deadline_offset: Schema.optionalKey(Seconds(604_800)),
  queue_full_alarm: Schema.optionalKey(AlarmName),
  isolation: Schema.optionalKey(Schema.Literals(["vm", "container"])),
});
export type ClassEntry = typeof ClassEntry.Type;

// ---------------------------------------------------------------------------
// Intent kinds and effect classes (profiles.md § Intent kinds, § Effect classes)

export const LifecycleTrigger = Schema.Literals([
  "terminal",
  "admitted",
  "lease-granted",
  "accepted",
]);
export type LifecycleTrigger = typeof LifecycleTrigger.Type;

export const DeliveryTier = Schema.Literals(["outcome", "effect", "progress"]);
export type DeliveryTier = typeof DeliveryTier.Type;

export const IntentKindEntry = Schema.Struct({
  origin: Schema.Literals(["run", "control-plane", "both"]),
  on: Schema.optionalKey(LifecycleTrigger),
  payload: Schema.optionalKey(BindingName),
  delivery_tier: DeliveryTier,
  applied_for: Schema.Union([
    Schema.Literal("any"),
    Schema.NonEmptyArray(Schema.Literals(["success", "failure", "cancelled", "skipped"])),
  ]),
  draws_reserve: Schema.optionalKey(Schema.Boolean),
  priority: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9 }))),
  opens_surface: Schema.optionalKey(Schema.Boolean),
  void_after_outcome: Schema.optionalKey(Schema.Boolean),
  in_order: Schema.optionalKey(Schema.Boolean),
  ops: Schema.optionalKey(Schema.Boolean),
  effect_class: Schema.Literals(["replay-safe", "adoptable", "reconcile-only"]),
  applier: BindingName,
  marker: Schema.optionalKey(Schema.String.check(Schema.isBetweenLength(1, 128))),
  gated: Schema.optionalKey(Schema.Boolean),
});
export type IntentKindEntry = typeof IntentKindEntry.Type;

export const Delivery = Schema.Struct({
  limit_key: Schema.optionalKey(BindingName),
  freeze_key: Schema.optionalKey(BindingName),
  ops_class: Schema.optionalKey(Name),
  undelivered_alarm: Schema.optionalKey(AlarmName),
});

// ---------------------------------------------------------------------------
// Placement constraints (profiles.md § Placement constraints)

/**
 * A predicate over the request a constraint may hold for: its class, the placement and capability labels it
 * carries, its trigger, and whether its run declares a class.
 */
export type Predicate =
  | { readonly _tag: "Class"; readonly name: string }
  | { readonly _tag: "Label"; readonly name: string }
  | { readonly _tag: "Trigger"; readonly kind: string }
  | { readonly _tag: "UndeclaredClass" }
  | { readonly _tag: "Not"; readonly predicate: Predicate }
  | { readonly _tag: "All"; readonly predicates: readonly Predicate[] }
  | { readonly _tag: "Any"; readonly predicates: readonly Predicate[] };

export const Predicate: Schema.Codec<Predicate> = Schema.Union([
  Schema.TaggedStruct("Class", { name: Name }),
  Schema.TaggedStruct("Label", { name: Name }),
  Schema.TaggedStruct("Trigger", { kind: Name }),
  Schema.TaggedStruct("UndeclaredClass", {}),
  Schema.TaggedStruct("Not", { predicate: Schema.suspend(() => Predicate) }),
  Schema.TaggedStruct("All", { predicates: Schema.Array(Schema.suspend(() => Predicate)) }),
  Schema.TaggedStruct("Any", { predicates: Schema.Array(Schema.suspend(() => Predicate)) }),
]);

export const ConfidentialityMode = Schema.Literals([
  "non-confidential",
  "unclassified",
  "confidential-model",
  "confidential-compute",
]);
export const Reachability = Schema.Literals(["public", "snapshot", "device-local"]);

const PlacementShape = Schema.Struct({
  class: Schema.Union([Schema.Literal("any"), Name]),
  labels: Schema.Union([Schema.Literal("any"), Schema.Array(Name)]),
  confidentiality: Schema.Union([Schema.Literal("any"), ConfidentialityMode]),
  reachability: Schema.Union([Schema.Literal("any"), Reachability]),
});
export type PlacementShape = typeof PlacementShape.Type;

export const DeclaredConstraint = Schema.Struct({
  name: Name,
  holds_for: Predicate,
  removes: Schema.NonEmptyArray(ExecutorKindName),
  requires_posture: Schema.optionalKey(
    Schema.Literals(["attested-dedicated", "managed-workstation"]),
  ),
});
export type DeclaredConstraint = typeof DeclaredConstraint.Type;

export const Placement = Schema.Struct({
  cloud_pinned: Predicate,
  cloud_only: Predicate,
  local_only: Predicate,
  cloud_pinned_kinds: Schema.NonEmptyArray(ExecutorKindName),
  launcher_kinds: Schema.Array(ExecutorKindName).check(Schema.isMaxLength(4)),
  constraints: Schema.Array(DeclaredConstraint),
  required: Schema.Array(PlacementShape).check(Schema.isMaxLength(64)),
  unreachable: Schema.Array(PlacementShape).check(Schema.isMaxLength(64)),
});

// ---------------------------------------------------------------------------
// The document

export const RuntimeAdapter = Schema.Literals(["host-cloudflare", "host-node"]);

export const ProfileDocument = Schema.Struct({
  policy_version: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9._-]+$/),
    Schema.isBetweenLength(1, 64),
  ),
  classes: Schema.Array(ClassEntry).check(Schema.isBetweenLength(1, 16)),
  reclaim_policy: Schema.Record(Name, Schema.Literals(["restart", "resume", "hold"])),
  intent_kinds: Schema.Record(Schema.String, IntentKindEntry),
  delivery: Delivery,
  placement: Placement,
  host: Schema.Struct({ adapter: RuntimeAdapter, features: Schema.Array(Schema.String) }),
});
export type ProfileDocument = typeof ProfileDocument.Type;

/** One reason the profile is not accepted: the item, the field path and why (MAMEKO-PROF-011). */
export const Rejection = Schema.Struct({
  item: Schema.String,
  path: Schema.String,
  reason: Schema.String,
});
export type Rejection = typeof Rejection.Type;

/** The decode or the profile validator refused the document; every rejection is listed, not only the first. */
export class ProfileRejected extends Schema.TaggedError<ProfileRejected>()("ProfileRejected", {
  policy_version: Schema.String,
  rejections: Schema.Array(Rejection),
}) {}
