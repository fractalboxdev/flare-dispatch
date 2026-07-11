// FlareDispatch Dispatcher — `GET /v1/mailbox/:localPart`.
//
// The CONTAINER-side read surface of the `mailbox` capability: when a demo
// agent / Playwright spec running inside the sandbox is the one driving the
// login form, it polls this route to read the OTP it must type. (The in-Workflow
// path — `waitForOtp` — gets the message by `step.waitForEvent` signal instead
// and never touches this route.)
//
// --- Auth & blast-radius posture --------------------------------------------
//
// This route is TOKEN-ONLY, deliberately OUTSIDE the Cloudflare Access wall the
// viewer surfaces sit behind: a container cannot carry an Access SSO JWT. So the
// only gate is an HMAC capability token bound to (localPart, expiry) — and,
// unlike the per-execution log token, it EXPIRES (mailbox-token.ts), because it
// rides in a container's env / `curl` line where it can leak. A reviewer flagged
// this as the one credential-bearing surface outside Access; the mitigations
// are: short token TTL, a tight row TTL, and BURN-AFTER-READ — the first
// successful read consumes the row (`consumed_at`), so a leaked token replays to
// nothing once the legitimate poll has fired.
//
// Spec: specs/03-dsl.md § mailbox, .tmp/email-otp-design.md § 10.3.

import { extractOtp, isInboxLocalPart } from "@fractalbox/flare-dispatch-core";
import type { Env } from "../env";
import { resolveMailboxLinkSecret, verifyMailboxToken } from "../mailbox-token";

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

type MessageRow = {
  readonly id: string;
  readonly sender: string | null;
  readonly subject: string | null;
  readonly text_body: string | null;
  readonly received_at: number;
};

/**
 * Handle `GET /v1/mailbox/:localPart?exp=<epochS>&t=<token>[&host=<linkHost>]`.
 *
 * Returns the latest unconsumed message for `localPart` (and burns it), with a
 * best-effort `{ code, link }` extraction. `host`, when given, biases magic-link
 * extraction to that provider domain.
 *
 * @param env        binding env (`RUNS_METADATA`, the mailbox-link secret).
 * @param localPart  the `demo-<rand>` local-part (the allocations key).
 * @param url        the request URL — carries `exp`, `t`, optional `host`.
 * @returns `200` with the message JSON, `404` when no message yet (poll again),
 *          `403` on a bad/expired token, `503` when no key material is set.
 */
export const handleMailboxRead = async (
  env: Env,
  localPart: string,
  url: URL,
): Promise<Response> => {
  if (!isInboxLocalPart(localPart)) {
    return json({ error: "not_found" }, 404);
  }

  const secret = resolveMailboxLinkSecret(env);
  if (secret === undefined) {
    return json(
      {
        error: "mailbox_not_configured",
        message:
          "neither MAILBOX_LINK_SECRET nor HMAC_SECRET is set; the mailbox read surface is off on this deploy",
      },
      503,
    );
  }

  const expEpochS = Number(url.searchParams.get("exp"));
  const presented = url.searchParams.get("t");
  const nowS = Math.floor(Date.now() / 1000);
  const ok = await verifyMailboxToken(secret, localPart, expEpochS, presented, nowS);
  if (!ok) {
    return json(
      { error: "forbidden", message: "mailbox token missing, invalid, or expired" },
      403,
    );
  }

  const db = env.RUNS_METADATA;
  const row = await db
    .prepare(
      "SELECT id, sender, subject, text_body, received_at FROM inbox_messages " +
        "WHERE local_part = ? AND consumed_at IS NULL ORDER BY received_at DESC LIMIT 1",
    )
    .bind(localPart)
    .first<MessageRow>();

  if (row === null) {
    // No message yet — the container poller retries until its own deadline.
    return json({ error: "no_message", localPart }, 404);
  }

  // Burn-after-read: consume the row so a leaked token can't re-read it.
  await db
    .prepare("UPDATE inbox_messages SET consumed_at = ? WHERE id = ?")
    .bind(Date.now(), row.id)
    .run();

  const subject = row.subject ?? "";
  const text = row.text_body ?? "";
  const host = url.searchParams.get("host") ?? undefined;
  const extracted = extractOtp(
    { subject, text },
    host !== undefined ? { linkHost: host } : undefined,
  );

  return json(
    {
      id: row.id,
      localPart,
      sender: row.sender ?? "",
      subject,
      text,
      receivedAt: row.received_at,
      ...(extracted.code !== undefined ? { code: extracted.code } : {}),
      ...(extracted.link !== undefined ? { link: extracted.link } : {}),
    },
    200,
  );
};
