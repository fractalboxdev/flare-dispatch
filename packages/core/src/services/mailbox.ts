// @fractalbox/flare-dispatch-core — the `mailbox` capability (disposable inbox).
//
// `mailbox.allocate` mints a fresh, disposable email address scoped to this
// execution and records it durably so the inbound `email()` handler can route a
// received message back to this run. It is the provisioning half of the
// OTP/magic-link testing loop; the WAITING half is the `waitForOtp` primitive
// (primitives/wait-for-otp.ts), which hibernates on `step.waitForEvent` until
// the handler signals the message in.
//
// `allocate` is intentionally the WHOLE capability surface — minting + the
// durable `localPart → executionId` record. It is non-deterministic (random
// local-part, a clock-based expiry, a D1 write), so a run must call it inside a
// `step(...)` to be replay-safe; the `provisionInbox` primitive does exactly
// that, so runs should prefer it over the raw accessor. The blocking WAIT is
// NOT a method here — the only surface that hibernates a run in this codebase is
// `StepRunner.waitForEvent`, deliberately, so `waitForOtp` composes that.
//
// The live Layer (`@fractalbox/flare-dispatch-runtime-cf`'s `makeMailboxLive`) is backed by
// Cloudflare Email Routing + D1; absent an `INBOX_DOMAIN` the runtime binds a
// dying stub so a misconfigured deploy fails loudly rather than minting
// addresses no inbound rule will ever deliver to.
//
// Spec: specs/03-dsl.md § mailbox, .tmp/email-otp-design.md.

import { Context, Effect } from "effect";
import type { InboxAddress } from "../mailbox/contract";

/** Options for a single inbox allocation. */
export type AllocateOpts = {
  /** A short stable label to disambiguate multiple inboxes within one run —
   * folded into the durable record + the `provisionInbox` step name. */
  readonly label?: string;
  /** Override the inbox + read-token lifetime (seconds). Default
   * `INBOX_DEFAULT_TTL_SEC`. */
  readonly ttlSec?: number;
};

/** The service contract a runtime Layer implements. */
export interface MailboxService {
  /**
   * Mint a disposable address for THIS execution and persist the
   * `localPart → executionId` record the inbound handler resolves against.
   * Non-deterministic — call inside a `step(...)` (use `provisionInbox`).
   */
  readonly allocate: (opts?: AllocateOpts) => Effect.Effect<InboxAddress>;
}

/** Context.Tag — the mailbox dependency a provisioning run carries. */
export class Mailbox extends Context.Tag("@fractalbox/flare-dispatch-core/Mailbox")<
  Mailbox,
  MailboxService
>() {}

/**
 * The `mailbox` accessor namespace — reads the Mailbox service from context and
 * delegates, so a run writes `mailbox.allocate(...)` rather than the explicit
 * `Effect.flatMap(Mailbox, ...)`.
 */
export const mailbox = {
  allocate: (opts?: AllocateOpts) =>
    Effect.flatMap(Mailbox, (s) => s.allocate(opts)),
} as const;
