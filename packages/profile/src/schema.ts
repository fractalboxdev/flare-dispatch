// The profile's types come from mameko's `ProfileSchema`, which decodes every
// item, `line` and the placement predicates included. This package holds
// FlareDispatch's values and its validator's rejection, not a schema of its own.
import type { Predicate, ProfileDocumentBody } from "@fractalboxdev/mameko-ports";
import { Schema } from "effect";

export type Profile = ProfileDocumentBody;
export type ClassEntry = Profile["classes"][number];
export type IntentKindEntry = Profile["intent_kinds"][string];
export type PlacementShape = Profile["placement"]["required"][number];
export type LifecycleTrigger = NonNullable<IntentKindEntry["on"]>;
export type { Predicate };

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
