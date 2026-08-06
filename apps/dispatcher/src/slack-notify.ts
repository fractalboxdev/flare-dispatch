// FlareDispatch Dispatcher — the verdict callback for slack-origin runs.
//
// A slack-origin dispatch is fire-and-forget: the caller gets a 202 and the
// thread gets nothing until the run finishes. The verdict then has to travel
// back to the thread it came from — and this dispatcher must not be the thing
// that posts it. Slack bot tokens live with the Slack ingress and stay there;
// giving a CI dispatcher a workspace-write credential to save one hop is how a
// token ends up somewhere nobody meant it to be.
//
// So the finalize boundary does what it already does for GitHub — completes
// the check-run — and then POSTs the same verdict, HMAC-signed, to the Slack
// ingress's callback endpoint. That side verifies the signature and posts
// in-thread with the token it already holds. One direction of trust, no new
// credential here.
//
// --- The signature -----------------------------------------------------------
//
//   X-FlareDispatch-Signature: sha256=<hex over the raw JSON body bytes>
//
// The same header, the same raw-bytes canonicalization, and the same `sign`
// primitive as the inbound dispatch route (hmac.ts) — so the receiver's
// verification is the code it already wrote to sign dispatches, read backwards.
// The KEY is different: HKDF-derived from `SLACK_NOTIFY_SECRET` (or, by
// default, from `HMAC_SECRET`) under this file's own label, so a callback
// signature can never be replayed as a dispatch signature or vice versa. The
// receiver derives it the same way:
//
//   k = HKDF-SHA256(ikm, salt="", info="flare-dispatch/slack-notify/v1")
//
// Delivery is best-effort and bounded, like the completion-notify email: a
// failed callback is a logged line, never a flip of a verdict the run already
// earned.
//
// Spec: apps/dispatcher/specs/slack-origin.md § The verdict callback.

import { deriveSecret } from "./capability-token";
import type { Env } from "./env";
import { SIGNATURE_HEADER, sign } from "./hmac";
import { SLACK_NOTIFY_URL_KEY, type SlackOrigin } from "./slack-origin";

/** HKDF `info` label — domain-separates the callback key from the dispatch HMAC. */
export const SLACK_NOTIFY_HKDF_INFO = "flare-dispatch/slack-notify/v1";

/** How long the callback may take before we give up and log. */
const CALLBACK_TIMEOUT_MS = 10_000;

/** The terminal verdict, same family as the check-run conclusion. */
export type SlackVerdictStatus = "success" | "failure" | "skipped";

/**
 * The callback body. Facts plus one pre-rendered line: the receiver owns Slack
 * formatting (blocks, mrkdwn, its own thread conventions) and may ignore
 * `text` entirely, but a receiver that just wants to post something correct
 * has it without re-deriving the wording.
 */
export type SlackVerdictPayload = {
  readonly version: 1;
  readonly executionId: string;
  readonly run: string;
  readonly status: SlackVerdictStatus;
  readonly repo: string;
  readonly sha: string;
  /** Echoed verbatim so the receiver knows which thread this belongs to. */
  readonly origin: SlackOrigin;
  /** A ready-to-post one-liner. */
  readonly text: string;
  /** The check-run this verdict also landed on, when the App is configured. */
  readonly checkRunName?: string;
  /** Readable full-log viewer, when the deploy has a public origin. */
  readonly logsUrl?: string;
  /** Cloudflare Workflows instance page — operator-only, may 403 for others. */
  readonly detailsUrl?: string;
  /** Run-authored failure markdown, on the failure branch only. */
  readonly failureSummary?: string;
};

const VERDICT_PREFIX: Record<SlackVerdictStatus, string> = {
  success: "✓",
  failure: "✗",
  skipped: "⊘",
};

const VERDICT_WORD: Record<SlackVerdictStatus, string> = {
  success: "succeeded",
  failure: "failed",
  skipped: "was skipped",
};

export type RenderSlackVerdictInput = {
  readonly executionId: string;
  readonly run: string;
  readonly status: SlackVerdictStatus;
  readonly repo: string;
  readonly sha: string;
  readonly origin: SlackOrigin;
  readonly checkRunName?: string;
  readonly logsUrl?: string;
  readonly detailsUrl?: string;
  readonly failureSummary?: string;
  /** The reason a `skipped` run bowed out, when the run supplied one. */
  readonly skipReason?: string;
};

/** Build the callback body. Pure — no I/O, no clock, no crypto. */
export const renderSlackVerdict = (input: RenderSlackVerdictInput): SlackVerdictPayload => {
  const head = `${VERDICT_PREFIX[input.status]} \`${input.run}\` ${VERDICT_WORD[input.status]} on \`${input.repo}\`@\`${input.sha.slice(0, 7)}\``;
  const reason =
    input.status === "skipped" && input.skipReason !== undefined && input.skipReason.length > 0
      ? ` — ${input.skipReason}`
      : "";
  const link = input.logsUrl !== undefined ? ` — <${input.logsUrl}|full logs>` : "";
  return {
    version: 1,
    executionId: input.executionId,
    run: input.run,
    status: input.status,
    repo: input.repo,
    sha: input.sha,
    origin: input.origin,
    text: `${head}${reason}${link}`,
    ...(input.checkRunName !== undefined ? { checkRunName: input.checkRunName } : {}),
    ...(input.logsUrl !== undefined ? { logsUrl: input.logsUrl } : {}),
    ...(input.detailsUrl !== undefined ? { detailsUrl: input.detailsUrl } : {}),
    ...(input.failureSummary !== undefined && input.status === "failure"
      ? { failureSummary: input.failureSummary }
      : {}),
  };
};

/**
 * The keying material for the callback signature: a dedicated
 * `SLACK_NOTIFY_SECRET` when set, else `HMAC_SECRET`. `undefined` only when
 * neither exists — the callback is then skipped rather than sent unsigned.
 */
export const resolveSlackNotifySecret = (env: Env): string | undefined => {
  const dedicated = env.SLACK_NOTIFY_SECRET;
  if (typeof dedicated === "string" && dedicated.length > 0) return dedicated;
  const hmac = env.HMAC_SECRET;
  if (typeof hmac === "string" && hmac.length > 0) return hmac;
  return undefined;
};

/**
 * The callback endpoint for this deploy — CONFIG_KV first, then the var, the
 * same precedence as the rest of the slack-origin config. `undefined` ⇒ no
 * callback is attempted.
 */
export const readSlackNotifyUrl = async (env: Env): Promise<string | undefined> => {
  const configured =
    env.CONFIG_KV === undefined ? null : await env.CONFIG_KV.get(SLACK_NOTIFY_URL_KEY);
  if (typeof configured === "string" && configured.trim().length > 0) return configured.trim();
  const fromVar = env.SLACK_NOTIFY_URL;
  if (typeof fromVar === "string" && fromVar.trim().length > 0) return fromVar.trim();
  return undefined;
};

export type SlackVerdictDelivery =
  | { readonly delivered: true; readonly status: number }
  | { readonly delivered: false; readonly reason: string };

/**
 * Sign and POST the verdict. Never throws: every failure path — a non-2xx, a
 * network error, a timeout — comes back as `delivered: false` with a reason
 * the caller logs.
 */
export const deliverSlackVerdict = async (opts: {
  readonly url: string;
  readonly secret: string;
  readonly payload: SlackVerdictPayload;
  /** Injected in tests; defaults to the ambient `fetch`. */
  readonly fetchImpl?: typeof fetch;
}): Promise<SlackVerdictDelivery> => {
  const body = new TextEncoder().encode(JSON.stringify(opts.payload));
  const key = await deriveSecret(opts.secret, SLACK_NOTIFY_HKDF_INFO);
  const signature = await sign(key, body);
  const doFetch = opts.fetchImpl ?? fetch;

  try {
    const response = await doFetch(opts.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signature,
      },
      body,
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { delivered: false, reason: `callback answered ${response.status}` };
    }
    return { delivered: true, status: response.status };
  } catch (cause) {
    return {
      delivered: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
};
