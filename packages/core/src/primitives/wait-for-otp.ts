// Primitive: provisionInbox + waitForOtp — the OTP/magic-link auth loop.
//
// The two-call shape a recipe uses to drive an email-OTP or magic-link login
// (Auth0 / Clerk / Stytch / Supabase / our own app):
//
//   const inbox = yield* provisionInbox();           // fresh disposable address
//   // …drive the target: fill `inbox.address` into the signup form, submit…
//   const { code, link } = yield* waitForOtp({ inbox });
//   // …type `code` into the OTP field, or navigate `link`…
//
// `provisionInbox` wraps `mailbox.allocate` in a `step(...)` so the minted
// address (random + clock-based + a D1 write) is CHECKPOINTED — replay returns
// the same address, never a fresh one. `waitForOtp` hibernates on
// `step.waitForEvent`: the inbound `email()` handler (apps/dispatcher) resolves
// the address back to THIS execution and `sendEvent`s the message in, resuming
// the run with zero CPU spent waiting. Extraction (code/link) runs in-Worker
// after the event, against the chosen provider's heuristics.
//
// Why event-driven, not a poll loop: `io.sleep` is a bare `Effect.sleep`, not a
// durable `step.sleep`, so a poll-over-D1 loop is NOT replay-safe in a CF
// Workflow. `step.waitForEvent` is the codebase's only correct "hibernate until
// an external signal" seam (it backs `release-notes`' approval pause).
//
// Layer: 03-dsl § Primitives. Rides on the `mailbox` capability + `step`.

import { type Duration, Effect } from "effect";
import {
  INBOX_DEFAULT_WAIT,
  INBOX_EVENT_TYPE,
  InboxMessage,
  type InboxAddress,
} from "../mailbox/contract";
import { extractOtp } from "../mailbox/extract";
import { mailbox, type AllocateOpts } from "../services/mailbox";
import { step } from "../step";

/**
 * Provision a fresh disposable inbox for this execution, checkpointed so the
 * address is stable across replay. Returns the address to hand the auth
 * provider plus the read token the container-side path needs.
 */
export const provisionInbox = (opts?: AllocateOpts) =>
  step(
    `provision-inbox${opts?.label !== undefined ? `-${opts.label}` : ""}`,
    () => mailbox.allocate(opts),
  );

/** What a verification email yielded: a numeric/alphanumeric OTP code, a magic
 * link, or both — plus the raw message for the run to inspect. */
export type OtpResult = {
  readonly code?: string;
  readonly link?: string;
  readonly message: InboxMessage;
};

/**
 * Hibernate until the verification email for `inbox` arrives (or time out), then
 * extract the OTP code / magic link.
 *
 * Fails with `ApprovalTimedOut` (no message within `timeout`) or
 * `EventPayloadInvalid` (a malformed signal) — both already in the `step`
 * error vocabulary, so a recipe handles them with `Effect.catchTag` like any
 * other run failure.
 *
 * @param inbox      the `provisionInbox` result (its `localPart` names the wait
 *                   step so it is unique + replay-stable).
 * @param timeout    max wait — default `INBOX_DEFAULT_WAIT` (120s); raise it for
 *                   providers with slow mail.
 * @param codePattern  override the code regex (first capture group); default is
 *                   a context-anchored numeric matcher (see extract.ts).
 * @param codeWidth  pin the expected code length (most OTPs are exactly 6).
 * @param linkHost   prefer magic links whose host matches the provider's auth
 *                   domain — strongly recommended for magic-link flows.
 */
export const waitForOtp = (opts: {
  readonly inbox: Pick<InboxAddress, "localPart">;
  readonly timeout?: Duration.Duration | string;
  readonly codePattern?: RegExp;
  readonly codeWidth?: number;
  readonly linkHost?: string;
}): Effect.Effect<
  OtpResult,
  import("../errors").ApprovalTimedOut | import("../errors").EventPayloadInvalid,
  import("../context").RunContext
> =>
  Effect.gen(function* () {
    const message = yield* step.waitForEvent(`wait-otp-${opts.inbox.localPart}`, {
      type: INBOX_EVENT_TYPE,
      timeout: opts.timeout ?? INBOX_DEFAULT_WAIT,
      payloadSchema: InboxMessage,
    });
    const extracted = extractOtp(
      { subject: message.subject, text: message.text },
      {
        ...(opts.codePattern !== undefined ? { codePattern: opts.codePattern } : {}),
        ...(opts.codeWidth !== undefined ? { codeWidth: opts.codeWidth } : {}),
        ...(opts.linkHost !== undefined ? { linkHost: opts.linkHost } : {}),
      },
    );
    return {
      ...(extracted.code !== undefined ? { code: extracted.code } : {}),
      ...(extracted.link !== undefined ? { link: extracted.link } : {}),
      message,
    } satisfies OtpResult;
  });
