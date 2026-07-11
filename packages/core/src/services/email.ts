// @fractalbox/flare-dispatch-core — the `email` capability (notification email).
//
// `EmailService.send` delivers an HTML (optionally + plain-text) message to a
// list of recipients. It is a *reporting* capability, in the same family as
// `checks`: a run's success or failure must never hinge on whether a
// notification went out. So `send` is **total** — it has no error channel.
// Per-recipient delivery outcomes are returned as data (`accepted` / `rejected`)
// and a wholly-unbacked deploy degrades to `skipped: true` rather than failing.
//
// The live binding (`@fractalbox/flare-dispatch-runtime-cf`'s `makeEmailCloudflareLive`)
// is backed by Cloudflare Email Routing's `send_email` binding — see that
// module for the verified-destination-address constraint Cloudflare enforces.
// The interface is provider-agnostic: a Resend / MailChannels / SES Layer can
// back the same Tag without any run-level change.
//
// Spec: specs/03-dsl.md § Capabilities, specs/04-gha-integration.md
// § Notifications.

import { Context, Effect } from "effect";

/** A single message to deliver to one or more recipients. */
export type EmailSendRequest = {
  /** Recipient addresses. With the Cloudflare backend each MUST be a verified
   * Email Routing destination address (the provider rejects others). */
  readonly to: readonly string[];
  /** Subject line. */
  readonly subject: string;
  /** HTML body — the primary rendering. */
  readonly html: string;
  /** Optional plain-text alternative for clients that don't render HTML. */
  readonly text?: string;
};

/** One recipient the provider refused, with a human-readable reason. */
export type EmailRejection = {
  readonly address: string;
  readonly reason: string;
};

/**
 * The outcome of a `send`. `accepted` + `rejected` partition the requested
 * recipients (a partial failure rejects only the offending addresses, never the
 * whole batch). `skipped` is `true` when the deploy has no email backend
 * configured — the call is a logged no-op, every recipient lands in neither
 * list.
 */
export type EmailSendResult = {
  readonly accepted: readonly string[];
  readonly rejected: readonly EmailRejection[];
  /** Provider message id of the first accepted send, when available. */
  readonly messageId?: string;
  /** `true` when no email backend is configured — the send was a no-op. */
  readonly skipped: boolean;
};

/** The service contract a runtime Layer implements. Total — no error channel. */
export interface EmailService {
  readonly send: (req: EmailSendRequest) => Effect.Effect<EmailSendResult>;
}

/** Context.Tag — the email dependency a run (and the Workflow finalize) carries. */
export class Email extends Context.Tag("@fractalbox/flare-dispatch-core/Email")<
  Email,
  EmailService
>() {}

/**
 * The `email` accessor namespace — reads the Email service from context and
 * delegates, so a run writes `email.send(...)` rather than the explicit
 * `Effect.flatMap(Email, ...)`.
 */
export const email = {
  send: (req: EmailSendRequest) => Effect.flatMap(Email, (s) => s.send(req)),
} as const;
