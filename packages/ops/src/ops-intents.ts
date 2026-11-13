// Ops intents: outbox rows with no execution, keyed `ops:<intent_key>`, that the drainer applies under the
// installation's permit like any other row (MAMEKO-OUT-058). mameko's coordinator exposes no `insertOpsIntent` at the
// pinned commit; this function writes the row MAMEKO-OUT-058 specifies through host-cloudflare's `insertOutboxRows`.
import type { Profile } from "@fractalboxdev/flare-dispatch-profile";
import { insertOutboxRows, type D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { newRow } from "@fractalboxdev/mameko-kernel";
import { Effect, Schema } from "effect";

/** The kind is not an `ops` kind of the profile. */
export class NotAnOpsKind extends Schema.TaggedError<NotAnOpsKind>()("NotAnOpsKind", {
  kind: Schema.String,
}) {}

const sha256 = async (text: string) => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
};

/** One ops intent to insert. `limitKey` is the installation whose permit the applier call takes. */
export interface OpsIntent {
  readonly scopeId: string;
  readonly intentKey: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly limitKey: string;
}

/**
 * Inserts the ops intent with `execution_id` null, the key `ops:<intent_key>` and the rank of `delivery.ops_class`;
 * a key that already has a row is left as it is (MAMEKO-OUT-058).
 */
export const insertOpsIntent = (db: D1Like, profile: Profile, intent: OpsIntent, now: number) =>
  Effect.gen(function* () {
    const entry = profile.intent_kinds[intent.kind];
    if (entry?.ops !== true) return yield* new NotAnOpsKind({ kind: intent.kind });
    const opsClass = profile.classes.find((c) => c.name === profile.delivery.ops_class);
    const key = `ops:${intent.intentKey}`;
    const payloadJson = JSON.stringify(intent.payload);
    const digest = yield* Effect.promise(() => sha256(payloadJson));
    yield* Effect.promise(() =>
      insertOutboxRows(db, [
        {
          id: `${intent.scopeId}/${key}`,
          limitKey: intent.limitKey,
          tier: entry.delivery_tier,
          priority: entry.priority ?? 2,
          classRank: opsClass?.rank ?? 1,
          drawsReserve: entry.draws_reserve === true,
          intent: {
            executionId: null,
            scopeId: intent.scopeId,
            intentKey: key,
            kind: intent.kind,
            payload: intent.payload,
            payloadDigest: digest,
            effectClass: entry.effect_class,
            attempts: 0,
          },
          row: newRow({ effectClass: entry.effect_class, insertedAt: now }),
        },
      ]),
    );
    return key;
  });
