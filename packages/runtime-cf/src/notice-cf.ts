// @fractalboxdev/flare-dispatch-runtime-cf — NoticeCloudflareLive: the live `notice` capability.
//
// Backs the `Notice` Tag with the dispatcher's signed emit path. What this
// Layer owns is the CAPABILITY's semantics — the delivery id, the degradation,
// the logging, the promise that nothing here can fail a run. What it does NOT
// own is the wire: the payload shape, the HKDF derivation, the HMAC and the
// receiver's contract all live in apps/dispatcher (`slack-notify.ts`), and this
// Layer reaches them through an injected `deliver` closure.
//
// That split is the same one `makeMailboxCloudflareLive` uses for `signToken`,
// and it exists for the same reason: runtime-cf must not depend on the app, and
// the keying material must not leave the Worker's own environment. This module
// never sees a secret, a URL, or a token — only a function that takes a message
// and reports what happened to it. substrate ADR-0006's never-store list stays
// true by construction rather than by discipline.
//
// --- The delivery id is derived, never drawn ---------------------------------
//
//   deliveryId = "<run>:<useCase>:<dedupeKey>"
//
// No clock, no randomness, no counter. The receiver dedups on this value, and a
// Workflow step can be retried — so an id that changed between attempts would
// double-post exactly when the dedup was supposed to save us. A run supplies the
// stable half (a scheduled run's day string); the run name and the use case are
// prefixed here so the id is unique across everything that shares that half.
//
// Both prefixes are load-bearing, in opposite directions. `run` keeps two runs
// announcing on the same day apart. `useCase` keeps ONE run's two announcements
// apart: `dedupeKey` is documented as "a scheduled run's day string", so a run
// that publishes a digest and an alert on the same tick would otherwise mint one
// id twice, and the second would be answered 409 and read as already delivered.
// That is the capability's worst failure — a dropped message reported as fine —
// reached without anything going wrong.
//
// `Math.random()` and `Date.now()` are also simply not available on some paths
// (a replayed Workflow step is fed its recorded result, not re-executed), which
// makes "derive it from the inputs" the only construction that is correct on
// every path rather than most of them.
//
// Spec: specs/03-dsl.md § Capabilities. Receiver contract: fractalbot
// `specs/flare-dispatch-notify.md`.

import { Effect, Layer, Match } from "effect";
import { Notice, type NoticeResult, type NoticeService } from "@fractalboxdev/flare-dispatch-core";

/** One message on its way out, as the dispatcher's emit path takes it. */
export type NoticeEmission = {
  readonly useCase: string;
  readonly deliveryId: string;
  readonly text: string;
  readonly links?: readonly { readonly url: string; readonly label: string }[];
  readonly run: string;
  readonly executionId: string;
};

/**
 * What the emit path reports back. Mirrors the receiver's own vocabulary so the
 * two halves describe the same events with the same words — `skipped` is the
 * one addition, for a deploy that has no ingress configured at all.
 */
export type NoticeEmissionResult =
  | { readonly outcome: "posted" }
  | { readonly outcome: "duplicate" }
  | { readonly outcome: "skipped"; readonly reason: string }
  | { readonly outcome: "failed"; readonly reason: string };

/**
 * The config the live `Notice` Layer needs but the run-agnostic `NoticeService`
 * interface does not carry. Supplied by `RunWorkflow`.
 */
export type NoticeCloudflareConfig = {
  /** The run doing the talking — the delivery-id prefix and the payload's `run`. */
  readonly run: string;
  /** This execution's id — logged by the receiver so a post is traceable. */
  readonly executionId: string;
  /**
   * Sign and POST one notice. Injected so the crypto, the secret and the
   * receiver contract stay in the Dispatcher (`slack-notify.ts`
   * `emitSlackNotice`). Must never throw — it reports failure as data.
   */
  readonly deliver: (emission: NoticeEmission) => Promise<NoticeEmissionResult>;
};

/**
 * FNV-1a (32-bit), hex. Not a security primitive — a short, deterministic tag
 * that survives a Workflow replay, which `crypto.randomUUID` and a hash needing
 * `await` both do not.
 */
const fnv1a32 = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

/**
 * The delivery id the receiver dedups on. Pure and total.
 *
 * Sanitized rather than validated: the run supplies part of this and the
 * receiver's charset is narrower than a run author will assume. Refusing a
 * notice because a day string grew a slash would be a silence nobody notices,
 * which is the worst failure this capability has — so the id is coerced into
 * the contract and the dispatcher's own check stays as the backstop.
 *
 * Coercion and the 128-char bound are both many-to-one, though, and a collision
 * here is the SAME silence arriving by another road: two distinct notices would
 * share an id and the second would be answered 409. So whenever either step
 * actually loses information, a hash of the original is appended — the id stays
 * a pure function of its inputs, and distinct inputs keep distinct ids.
 */
export const noticeDeliveryId = (run: string, useCase: string, dedupeKey: string): string => {
  const raw = `${run}:${useCase}:${dedupeKey}`;
  const cleaned = raw.replace(/[^A-Za-z0-9._:-]/g, "-");
  // The receiver requires an alphanumeric first character.
  const started = /^[A-Za-z0-9]/.test(cleaned) ? cleaned : `x${cleaned}`;
  if (started === raw && started.length <= 128) return started;

  const tag = `-${fnv1a32(raw)}`;
  return `${started.slice(0, 128 - tag.length)}${tag}`;
};

/**
 * A no-op `NoticeService` that logs and reports `skipped: true` — the
 * graceful-degradation path when a deploy has no notice backend. Mirrors
 * `makeNoopEmail`: the run proceeds, only the announcement is skipped.
 */
const makeNoopNotice = (reason: string): NoticeService => ({
  publish: ({ useCase }) =>
    Effect.as(Effect.logInfo(`notice.publish skipped (${reason}) — useCase=${useCase}`), {
      delivered: false,
      duplicate: false,
      skipped: true,
      reason,
    } satisfies NoticeResult),
});

/**
 * Build the `Notice` Layer. `undefined` config selects the no-op service above;
 * otherwise the live emit path.
 *
 * The service is TOTAL. Every branch — a refusal, a 500, a timeout, even a
 * defect thrown by the injected closure — resolves to a `NoticeResult` and a
 * log line. A run's verdict is earned by what it did, and an announcement that
 * did not land is not one of those things.
 */
export const makeNoticeCloudflareLive = (
  config: NoticeCloudflareConfig | undefined,
): Layer.Layer<Notice> => {
  if (config === undefined) {
    return Layer.succeed(Notice, makeNoopNotice("no notice ingress configured on this deploy"));
  }

  const service: NoticeService = {
    publish: (req) =>
      Effect.gen(function* () {
        const emission: NoticeEmission = {
          useCase: req.useCase,
          deliveryId: noticeDeliveryId(config.run, req.useCase, req.dedupeKey),
          text: req.text,
          ...(req.links !== undefined && req.links.length > 0 ? { links: req.links } : {}),
          run: config.run,
          executionId: config.executionId,
        };

        const result = yield* Effect.promise(() => config.deliver(emission)).pipe(
          // The closure is contracted never to throw; a defect here would still
          // be a notice bug turning a green run red at the last step, so it is
          // caught and demoted to the same logged line as any other failure.
          Effect.catchAllDefect((defect) =>
            Effect.succeed({
              outcome: "failed",
              reason: defect instanceof Error ? defect.message : String(defect),
            } as const satisfies NoticeEmissionResult),
          ),
        );

        // `discriminatorsExhaustive` rather than a `switch`, matching
        // `describeRefusal` in sandbox-facade.ts: the emit path's vocabulary is
        // the receiver's to grow, and a new outcome must break this build rather
        // than fall through and hand a run `undefined` as its NoticeResult.
        return yield* Match.value(result).pipe(
          Match.discriminatorsExhaustive("outcome")({
            posted: () =>
              Effect.as(
                Effect.logInfo(
                  `notice.publish: ${req.useCase} posted (delivery=${emission.deliveryId})`,
                ),
                { delivered: true, duplicate: false, skipped: false } satisfies NoticeResult,
              ),
            // Not a failure: a retry meeting its own earlier post is the dedup
            // working. But it is not a delivery THIS attempt witnessed either —
            // the receiver's word is all there is, and `delivered` stays false
            // so the flag that says "a post reached Slack" is only ever set by
            // a 2xx the dispatcher actually received.
            //
            // Reserving 409 for a delivered id (never a merely claimed one) is
            // the receiver's obligation — apps/dispatcher/specs/slack-origin.md
            // § At most once, across a retry.
            duplicate: () =>
              Effect.as(
                Effect.logInfo(
                  `notice.publish: ${req.useCase} already claimed by the receiver as delivered ` +
                    `(delivery=${emission.deliveryId})`,
                ),
                { delivered: false, duplicate: true, skipped: false } satisfies NoticeResult,
              ),
            skipped: ({ reason }) =>
              Effect.as(Effect.logInfo(`notice.publish skipped (${reason}) — ${req.useCase}`), {
                delivered: false,
                duplicate: false,
                skipped: true,
                reason,
              } satisfies NoticeResult),
            failed: ({ reason }) =>
              Effect.as(
                Effect.logWarning(`notice.publish: ${req.useCase} not delivered — ${reason}`),
                {
                  delivered: false,
                  duplicate: false,
                  skipped: false,
                  reason,
                } satisfies NoticeResult,
              ),
          }),
        );
      }),
  };

  return Layer.succeed(Notice, service);
};
