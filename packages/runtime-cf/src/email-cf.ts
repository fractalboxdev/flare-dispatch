// @fractalbox/flare-dispatch-runtime-cf — EmailCloudflareLive: the live `email` capability.
//
// Backs the `Email` Context.Tag with Cloudflare Email Routing's `send_email`
// binding (`env.SEND_EMAIL`). The binding's builder overload — `send({ from,
// to, subject, html, text })` — constructs the RFC 5322 / MIME message itself,
// so this Layer carries no MIME plumbing.
//
// --- The verified-destination-address constraint -----------------------------
//
// Cloudflare's `send_email` binding can only deliver to addresses that have been
// **verified as Email Routing destination addresses** on the sender's zone, and
// `from` must be on that zone. This is Cloudflare's anti-abuse posture, not a
// FlareDispatch choice. For a fixed reviewer/stakeholder list (verify each once
// in the Email Routing dashboard) this is exactly right; for arbitrary external
// recipients a third-party transactional provider (Resend / MailChannels / SES)
// is required — the `EmailService` interface is provider-agnostic precisely so
// such a Layer can replace this one without touching any run.
//
// --- Per-recipient delivery + graceful degradation ---------------------------
//
// Each recipient is sent its own message (not one message with an array `to`):
// a single unverified address then rejects only itself instead of failing the
// whole batch, and recipients don't see each other. Email is *reporting* — like
// `checks`, a delivery failure must never fail an otherwise-green run — so the
// service is total: a rejected recipient lands in `rejected`, never the error
// channel. A deploy with no binding / no `EMAIL_FROM` degrades to a logged
// no-op (`skipped: true`).
//
// Spec: specs/03-dsl.md § Capabilities, specs/04-gha-integration.md
// § Notifications.

import { Effect, Layer } from "effect";
import {
  Email,
  type EmailRejection,
  type EmailSendResult,
  type EmailService,
} from "@fractalbox/flare-dispatch-core";

/**
 * The minimal surface of Cloudflare's `SendEmail` binding this Layer uses —
 * the builder overload. Typed locally (rather than importing the global
 * `SendEmail`) so the constructor stays decoupled from the workers-types
 * version and is trivially fakeable in unit tests.
 */
export type SendEmailBinding = {
  readonly send: (builder: {
    from: string | { name: string; email: string };
    to: string | string[];
    subject: string;
    html?: string;
    text?: string;
  }) => Promise<{ messageId: string }>;
};

/**
 * The Cloudflare email config the live `Email` Layer needs but the
 * run-agnostic `EmailService` interface does not carry. Supplied by
 * `RunWorkflow` from `env`.
 */
export type EmailCloudflareConfig = {
  /** `env.SEND_EMAIL` — the Email Routing `send_email` binding. */
  readonly sendEmail: SendEmailBinding;
  /** `EMAIL_FROM` — the verified sender address on the Email Routing zone. */
  readonly fromAddress: string;
  /** `EMAIL_FROM_NAME` — optional display name for the `From` header. */
  readonly fromName?: string;
  /**
   * Optional operator allowlist (`EMAIL_ALLOWED_RECIPIENTS`). When set, any
   * requested recipient not on it is rejected *before* the provider call — a
   * cheap second guard on top of Cloudflare's verified-destination check, so a
   * dispatch can't fan notifications at arbitrary addresses. Absent → every
   * requested recipient is forwarded to the provider (which still enforces its
   * own verified-destination constraint).
   */
  readonly allowedRecipients?: readonly string[];
};

/**
 * A no-op `EmailService` that logs and reports `skipped: true` — the
 * graceful-degradation path when no email backend is configured. Mirrors
 * `makeNoopChecks`: the run proceeds, only the notification is skipped.
 */
const makeNoopEmail = (reason: string): EmailService => ({
  send: ({ to }) =>
    Effect.as(
      Effect.logInfo(
        `email.send skipped (${reason}) — ${to.length} recipient(s) not notified`,
      ),
      { accepted: [], rejected: [], skipped: true },
    ),
});

/**
 * Build the `Email` Layer. `undefined` config (no `SEND_EMAIL` binding or no
 * `EMAIL_FROM`) selects the no-op service above; otherwise the live
 * Cloudflare-backed service.
 */
export const makeEmailCloudflareLive = (
  config: EmailCloudflareConfig | undefined,
): Layer.Layer<Email> => {
  if (config === undefined) {
    return Layer.succeed(
      Email,
      makeNoopEmail("SEND_EMAIL binding / EMAIL_FROM not configured"),
    );
  }

  const from =
    config.fromName !== undefined
      ? { name: config.fromName, email: config.fromAddress }
      : config.fromAddress;

  const service: EmailService = {
    send: ({ to, subject, html, text }) =>
      Effect.gen(function* () {
        // Partition by the optional operator allowlist first.
        const allow = config.allowedRecipients;
        const eligible =
          allow === undefined ? to : to.filter((r) => allow.includes(r));
        const disallowed: EmailRejection[] =
          allow === undefined
            ? []
            : to
                .filter((r) => !allow.includes(r))
                .map((address) => ({
                  address,
                  reason: "not in EMAIL_ALLOWED_RECIPIENTS",
                }));

        if (eligible.length === 0) {
          yield* Effect.logInfo(
            "email.send — no eligible recipients after allowlist filter",
          );
          return {
            accepted: [],
            rejected: disallowed,
            skipped: false,
          } satisfies EmailSendResult;
        }

        // Send one message per recipient — a single rejection (e.g. an
        // unverified destination address) then fails only that address.
        const outcomes = yield* Effect.forEach(
          eligible,
          (address) =>
            Effect.tryPromise({
              try: () =>
                config.sendEmail.send({
                  from,
                  to: address,
                  subject,
                  html,
                  ...(text !== undefined ? { text } : {}),
                }),
              catch: (cause) => ({ address, cause }),
            }).pipe(
              Effect.map(
                (res) =>
                  ({ ok: true, address, messageId: res.messageId }) as const,
              ),
              Effect.catchAll((err) =>
                Effect.as(
                  Effect.logWarning(
                    `email.send: recipient ${err.address} rejected — ${String(err.cause)}`,
                  ),
                  {
                    ok: false,
                    address: err.address,
                    reason:
                      err.cause instanceof Error
                        ? err.cause.message
                        : String(err.cause),
                  } as const,
                ),
              ),
            ),
          { concurrency: "unbounded" },
        );

        const accepted = outcomes
          .filter((o) => o.ok)
          .map((o) => o.address);
        const rejected: EmailRejection[] = [
          ...disallowed,
          ...outcomes
            .filter((o): o is Extract<typeof o, { ok: false }> => !o.ok)
            .map((o) => ({ address: o.address, reason: o.reason })),
        ];
        const firstMessageId = outcomes.find(
          (o): o is Extract<typeof o, { ok: true }> => o.ok,
        )?.messageId;

        return {
          accepted,
          rejected,
          ...(firstMessageId !== undefined ? { messageId: firstMessageId } : {}),
          skipped: false,
        } satisfies EmailSendResult;
      }),
  };

  return Layer.succeed(Email, service);
};
