// FlareDispatch Dispatcher — the INBOUND Cloudflare Email Routing handler.
//
// Cloudflare delivers mail addressed to a provisioned disposable inbox here via
// the Worker's `email()` export. The handler is the bridge between an OTP /
// magic-link verification message and the paused run that's waiting for it:
//
//   1. Reject any RCPT that is not a minted `demo-<rand>` local-part — BEFORE
//      touching `message.raw`, so a catch-all on a shared zone never buffers or
//      stores non-test mail (the storage guard, mailbox/contract.ts).
//   2. Enforce the optional envelope-From allowlist.
//   3. Resolve the paused execution via the `inbox_allocations` table (and honour
//      the row's `expires_at`).
//   4. Buffer the raw MIME ONCE, parse it, store a TEXT-ONLY message row.
//   5. Best-effort signal the paused `step.waitForEvent` with an `InboxMessage`.
//
// The ordering above is load-bearing: reject-before-parse is a security property,
// not an optimisation. The whole body is wrapped so a thrown parse/D1 error after
// the guards still ends cleanly (CF's behaviour on a thrown `email()` is
// undocumented; the message is already accepted by that point).

import {
  INBOX_TTL_SEC_DEFAULT,
  INBOX_EVENT_TYPE,
  type InboxMessage,
  parseInboxLocalPart,
} from "@fractalboxdev/flare-dispatch-core";
import type { Env } from "../env";
import { signalWorkflow } from "../signal-workflow";
import { parseEmail } from "../mime";

/** Cap stored body size — a received OTP / link is short; a huge body is just
 * storage cost and at-rest surface. 16 KB comfortably holds any provider mail
 * we target (codes live in the first lines / subject). */
const MAX_TEXT_BYTES = 16 * 1024;

/** Track the "no allowlist configured" warning so it logs once per isolate, not
 * once per message (a single isolate handles many deliveries). */
let warnedNoAllowlist = false;

/** The envelope-From domain (lowercased), or null if unparseable. */
const fromDomain = (from: string): string | null => {
  const at = from.lastIndexOf("@");
  if (at === -1) return null;
  const domain = from.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 ? domain : null;
};

/** True iff `from`'s domain is on the comma-separated allowlist. */
const senderAllowed = (from: string, allowlist: string): boolean => {
  const domain = fromDomain(from);
  if (domain === null) return false;
  const allowed = allowlist
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
  return allowed.includes(domain);
};

/** UTF-8 byte length of a string, capping the slice we store. */
const capUtf8 = (text: string, maxBytes: number): string => {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  // Binary-search a character boundary that fits — TextEncoder is multibyte.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
};

/**
 * Cloudflare Email Routing inbound handler. Wired into the Worker as the
 * `email(message, env, ctx)` export by the integrator. Never throws: the body
 * is fully wrapped, and any error after the guards pass just returns (the
 * message has already been accepted).
 */
export const handleInboundEmail = async (
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> => {
  // 1. RCPT guard — reject BEFORE touching `message.raw`. A non-`demo-` RCPT is
  //    rejected here, so we never buffer or store mail for a non-minted address.
  const localPart = parseInboxLocalPart(message.to);
  if (localPart === null) {
    message.setReject("no such mailbox");
    return;
  }

  // 2. Envelope-From allowlist (optional). If unset, allow — but warn once that
  //    default-on enforcement is recommended (the inbox docs cover it).
  const allowlist = env.INBOX_ALLOWED_SENDERS;
  if (allowlist !== undefined && allowlist.trim().length > 0) {
    if (!senderAllowed(message.from, allowlist)) {
      message.setReject("sender not allowed");
      return;
    }
  } else if (!warnedNoAllowlist) {
    warnedNoAllowlist = true;
    console.warn(
      "[email-handler] INBOX_ALLOWED_SENDERS is unset — accepting mail from any " +
        "envelope-From domain. Default-on enforcement (an explicit allowlist) is " +
        "recommended; see the inbox docs.",
    );
  }

  // 3. Allocation lookup — resolve the paused execution, honour the TTL. Still
  //    before reading the body: an unknown / expired mailbox never buffers raw.
  let allocation: { execution_id: string; expires_at: number } | null;
  try {
    allocation = await env.RUNS_METADATA.prepare(
      "SELECT execution_id, expires_at FROM inbox_allocations WHERE local_part = ?",
    )
      .bind(localPart)
      .first<{ execution_id: string; expires_at: number }>();
  } catch (cause) {
    // A D1 read failure here is an internal error BEFORE the message is
    // accepted, so reject (the sender can retry) rather than silently drop.
    console.error("[email-handler] allocation lookup failed", cause);
    message.setReject("temporary failure");
    return;
  }
  if (allocation === null) {
    message.setReject("no such mailbox");
    return;
  }
  if (allocation.expires_at < Date.now()) {
    message.setReject("mailbox expired");
    return;
  }

  const executionId = allocation.execution_id;

  // From here on the message is being ACCEPTED. Any failure must end cleanly
  // (log + return) — never throw, never `setReject` (that would be a protocol
  // error after we've committed to accepting).
  try {
    // 4. Buffer the raw MIME ONCE, then parse.
    const raw = await new Response(message.raw).arrayBuffer();
    const parsed = parseEmail(raw);
    // Prefer the header subject over the parsed one (the handler has the
    // unfolded header already decoded by the runtime).
    const subject = message.headers.get("subject") ?? parsed.subject ?? "";

    // 5. Store a TEXT-ONLY row (no html — a reviewer flagged stored magic links
    //    in the HTML alternative as account-takeover material).
    const id = crypto.randomUUID();
    const receivedAt = Date.now();
    const expiresAt = receivedAt + INBOX_TTL_SEC_DEFAULT * 1000;
    const textBody = capUtf8(parsed.text, MAX_TEXT_BYTES);

    try {
      await env.RUNS_METADATA.prepare(
        "INSERT INTO inbox_messages " +
          "(id, local_part, sender, subject, text_body, received_at, expires_at, consumed_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
      )
        .bind(
          id,
          localPart,
          message.from,
          subject,
          textBody,
          receivedAt,
          expiresAt,
        )
        .run();
    } catch (cause) {
      // The message is already accepted; a failed insert is logged, not thrown.
      console.error("[email-handler] inbox_messages insert failed", cause);
      return;
    }

    // 6. Best-effort signal the paused run. The run may instead consume via the
    //    read route (`GET /v1/mailbox/...`), so a `wf_not_found` is benign.
    const payload: InboxMessage = {
      id,
      localPart,
      recipient: message.to,
      sender: message.from,
      subject,
      text: textBody,
      receivedAt,
    };
    try {
      const outcome = await signalWorkflow(
        env.RUNS_WORKFLOW,
        executionId,
        INBOX_EVENT_TYPE,
        payload,
      );
      if (!outcome.ok && outcome.reason !== "wf_not_found") {
        // A genuine delivery failure (not just "no running instance") — log it;
        // the row is stored, so the read route can still serve the message.
        console.warn(
          `[email-handler] signal failed (${outcome.reason}): ${outcome.message}`,
        );
      }
    } catch (cause) {
      // signalWorkflow already swallows its own errors, but belt-and-braces.
      console.error("[email-handler] signalWorkflow threw", cause);
    }
  } catch (cause) {
    // Any parse/buffer error after the guards — log and return; the message is
    // already accepted, so do NOT throw out of `email()`.
    console.error("[email-handler] internal error after accept", cause);
    return;
  }
};
