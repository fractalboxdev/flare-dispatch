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
//   deliveryId = "<run>:<dedupeKey>"
//
// No clock, no randomness, no counter. The receiver dedups on this value, and a
// Workflow step can be retried — so an id that changed between attempts would
// double-post exactly when the dedup was supposed to save us. A run supplies the
// stable half (a scheduled run's day string); the run name is prefixed here so
// two runs publishing on the same day under the same use case cannot collide.
//
// `Math.random()` and `Date.now()` are also simply not available on some paths
// (a replayed Workflow step is fed its recorded result, not re-executed), which
// makes "derive it from the inputs" the only construction that is correct on
// every path rather than most of them.
//
// Spec: specs/03-dsl.md § Capabilities. Receiver contract: fractalbot
// `specs/flare-dispatch-notify.md`.

import { Effect, Layer } from "effect";
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
 * The delivery id the receiver dedups on. Pure and total.
 *
 * Sanitized rather than validated: the run supplies half of this and the
 * receiver's charset is narrower than a run author will assume. Refusing a
 * notice because a day string grew a slash would be a silence nobody notices,
 * which is the worst failure this capability has — so the id is coerced into
 * the contract and the dispatcher's own check stays as the backstop.
 */
export const noticeDeliveryId = (run: string, dedupeKey: string): string => {
  const raw = `${run}:${dedupeKey}`;
  const cleaned = raw.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 128);
  // The receiver requires an alphanumeric first character.
  return /^[A-Za-z0-9]/.test(cleaned) ? cleaned : `x${cleaned}`.slice(0, 128);
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
          deliveryId: noticeDeliveryId(config.run, req.dedupeKey),
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

        switch (result.outcome) {
          case "posted":
            yield* Effect.logInfo(
              `notice.publish: ${req.useCase} posted (delivery=${emission.deliveryId})`,
            );
            return { delivered: true, duplicate: false, skipped: false } satisfies NoticeResult;
          case "duplicate":
            // Not a failure. The receiver claims the id before it posts, so this
            // says the message is already in the room — the outcome we wanted,
            // reached by a retry doing exactly what it should.
            yield* Effect.logInfo(
              `notice.publish: ${req.useCase} already delivered (delivery=${emission.deliveryId})`,
            );
            return { delivered: false, duplicate: true, skipped: false } satisfies NoticeResult;
          case "skipped":
            yield* Effect.logInfo(`notice.publish skipped (${result.reason}) — ${req.useCase}`);
            return {
              delivered: false,
              duplicate: false,
              skipped: true,
              reason: result.reason,
            } satisfies NoticeResult;
          case "failed":
            yield* Effect.logWarning(
              `notice.publish: ${req.useCase} not delivered — ${result.reason}`,
            );
            return {
              delivered: false,
              duplicate: false,
              skipped: false,
              reason: result.reason,
            } satisfies NoticeResult;
        }
      }),
  };

  return Layer.succeed(Notice, service);
};
