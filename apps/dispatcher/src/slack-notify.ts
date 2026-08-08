// FlareDispatch Dispatcher — the two signed callbacks that reach a Slack room.
//
// This dispatcher must never be the thing that posts. Slack bot tokens live
// with the Slack ingress and stay there; giving a CI dispatcher a
// workspace-write credential to save one hop is how a token ends up somewhere
// nobody meant it to be (substrate ADR-0006 names consumer bot tokens on its
// never-store list for the same reason). So everything here signs a body and
// POSTs it; the receiver verifies and posts with the token it already holds.
//
// Two shapes ride that hop, and the difference between them is the design:
//
//   1. THE VERDICT CALLBACK — for a run that CAME FROM a Slack thread. The
//      dispatch carried a `SlackOrigin`, so the callback echoes it back and the
//      receiver posts in that thread. The caller names the destination because
//      the caller is relaying a conversation it was already in.
//
//   2. THE NOTICE — for a run that came from a cron. There is no thread, no
//      asker, and no standing to name a room, so the payload names a USE CASE
//      and the receiver resolves it against a map in its own deploy config. A
//      body that could name `C…` would turn one leaked key into "post as the
//      bot anywhere the bot can see", so there is no channel field and no
//      fallback to one.
//
// Neither path weakens the other, and it takes both halves to be true. The
// verdict callback is gated on an origin existing (workflow.ts, at the finalize
// boundary); the notice is reached only from inside a run through the `notice`
// capability, which cannot express a destination at all. And the two sign under
// separate derived keys, so "the notice cannot name a room" survives a leak of
// the notice's key — see the signature section below.
//
// --- The signature (same envelope, two keys) ---------------------------------
//
//   X-FlareDispatch-Signature: sha256=<hex over the raw JSON body bytes>
//
// The same header, the same raw-bytes canonicalization, and the same `sign`
// primitive as the inbound dispatch route (hmac.ts) — so the receiver's
// verification is the code it already wrote to sign dispatches, read backwards.
// The KEY is HKDF-derived from `SLACK_NOTIFY_SECRET` (or, by default, from
// `HMAC_SECRET`), so a callback signature can never be replayed as a dispatch
// signature or vice versa.
//
// The two shapes derive under DIFFERENT labels, and that is a security boundary
// rather than bookkeeping:
//
//   k_verdict = HKDF-SHA256(ikm, salt="", info="flare-dispatch/slack-notify/v1")
//   k_notice  = HKDF-SHA256(ikm, salt="", info="flare-dispatch/slack-notice/v1")
//
// One label would make them one key, and the two payloads are not equally
// dangerous. `SlackVerdictPayload.origin` carries `channel` and `thread_ts` —
// it NAMES a destination, because it is relaying a conversation the caller was
// already in. `SlackNoticePayload` deliberately cannot. Under a shared key,
// anything able to sign a notice could sign a verdict naming any channel the
// bot can see, and the notice's whole "the shape is the security property"
// argument would be worth nothing: the shape stops being a bound the moment the
// same key opens a shape without it. Splitting the label makes the weaker
// credential structurally unable to reach the stronger surface.
//
// The `ikm` is still one secret. Two labels off one secret is domain
// separation; two secrets would be a second thing to rotate for a separation
// HKDF already gives.
//
// One load-bearing detail: `deriveSecret` returns HEX and `sign` UTF-8 encodes
// its `secret` argument, so the HMAC key is the 64 ASCII bytes of the hex, not
// the 32 bytes it encodes. A receiver importing the raw bytes rejects every
// honest request, with nothing but a 401 to say why — which is what the
// cross-repo parity test in slack-notify.notice.test.ts exists to catch. The
// same test pins both label strings, because a receiver deriving the notice key
// under the old label fails exactly that way and no other.
//
// Delivery is best-effort and bounded, like the completion-notify email: a
// failed callback is a logged line, never a flip of a verdict the run already
// earned.
//
// Spec: apps/dispatcher/specs/slack-origin.md § The verdict callback,
// § The notice. Receiver contract: fractalbot `specs/flare-dispatch-notify.md`.

import { deriveSecret } from "./capability-token";
import type { Env } from "./env";
import { SIGNATURE_HEADER, sign } from "./hmac";
import { SLACK_NOTIFY_URL_KEY, type SlackOrigin } from "./slack-origin";

/**
 * HKDF `info` label for the VERDICT callback — domain-separates its key from
 * the dispatch HMAC.
 *
 * Unchanged, and it must stay unchanged: receivers already deployed verify
 * verdicts under this exact string. The split introduced below moves the
 * notice, never this.
 */
export const SLACK_NOTIFY_HKDF_INFO = "flare-dispatch/slack-notify/v1";

/**
 * HKDF `info` label for the NOTICE — its own key, not the verdict callback's.
 *
 * The verdict body names a destination (`origin.channel`, `origin.thread_ts`);
 * the notice body cannot. Sharing one label made them one key, which handed
 * every notice-key holder the ability to sign a verdict naming any channel the
 * bot can reach — collapsing the notice's central claim that its *shape* is
 * what bounds it. A shape is only a bound while nothing else can sign a
 * different shape with the same key.
 *
 * **Receiver-side change required.** fractalbot's `deriveNotifyKey` must derive
 * notices under this string. Until it does, every notice 401s — silently and
 * forever, because a notice failing is correctly never fatal. Ship the receiver
 * first; see the deploy-ordering note in `specs/slack-origin.md` § The notice.
 */
export const SLACK_NOTICE_HKDF_INFO = "flare-dispatch/slack-notice/v1";

/** How long a callback may take before we give up and log. */
const CALLBACK_TIMEOUT_MS = 10_000;

/**
 * The notice ingress URL, under its OWN CONFIG_KV key rather than reusing
 * `slack-origin.notify-url`.
 *
 * Three reasons, any one of which is enough:
 *
 *   - They are different ENDPOINTS. The verdict callback goes wherever the
 *     ingress exposes its verdict handler; a notice goes to the receiver's
 *     `/flare-dispatch/notify` route, which takes a different payload and
 *     answers different codes. One value cannot address both.
 *   - They are different AUTHORITIES. `slack-origin.*` is the namespace of the
 *     origin-gated policy (the repo pin, the run allowlist). A cron notice is
 *     not a slack-origin dispatch and must not inherit that policy's trust, nor
 *     be switched on as a side effect of enabling it.
 *   - They have different BLAST RADII, so an operator needs to move them
 *     independently — turning the announcement path off, or pointing it at a
 *     staging receiver, must not silence the in-thread verdicts a human is
 *     waiting on. The radii differ in the KEY too, not just the URL: the two
 *     derive under separate HKDF labels, so pointing this one at a staging
 *     receiver hands that receiver a key that cannot sign a verdict.
 */
export const SLACK_NOTICE_URL_KEY = "slack-notice.url";

// --- The verdict callback (origin-gated) -------------------------------------

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

// --- The notice (un-originated) ----------------------------------------------

/**
 * Contract bounds, mirrored from the receiver's `parseNotice`. Checked HERE so
 * a payload that would earn a 400 never becomes a network round trip and a log
 * line that says only "the receiver said 400" — the emit side knows exactly
 * which field it got wrong and can say so.
 */
const MAX_NOTICE_TEXT_CHARS = 12_000;
const MAX_NOTICE_LINKS = 4;
const MAX_NOTICE_URL_CHARS = 512;
const MAX_NOTICE_LABEL_CHARS = 80;
const NOTICE_USE_CASE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NOTICE_DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NOTICE_RUN_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * What a link LABEL may not contain. This is the one rule here that is NOT a
 * mirror: the receiver's `parseNotice` bounds a label by length alone, and then
 * renders it inside `<url|label>`. A label is model-authored like `text` is —
 * but unlike `text`, which the receiver escapes wholesale, it lands INSIDE a
 * markup span, where `>` closes the link early and `<` opens a fresh one. That
 * is enough to smuggle `<!channel>` or `<@U…>` past an escaper that never saw
 * the label as text.
 *
 * So the emit side refuses the three characters that span can be broken with.
 * A label is short display prose; none of them belong in one, and refusing
 * costs a legible local error instead of a message nobody meant to send.
 * `&` is deliberately NOT refused: Slack parses markup before entity decoding,
 * so `&lt;!channel&gt;` renders as literal text — and "Q&A" is a real label.
 *
 * Control characters go with them: a newline inside the span breaks it too.
 * This does not excuse the receiver from escaping — it is the half we control.
 * Receiver-side obligation: `specs/slack-origin.md` § The notice.
 */
// oxlint-disable-next-line no-control-regex
const NOTICE_LABEL_FORBIDDEN = /[<>|]|[\u0000-\u001f\u007f]/;

/** A link the receiver renders as `<url|label>` — never markup we build. */
export type SlackNoticeLink = {
  readonly url: string;
  readonly label: string;
};

/**
 * What the `notice` capability hands this module: everything about the message
 * EXCEPT the clock. `sentAt` is stamped at signing time, not at enqueue time —
 * the receiver's freshness window is five minutes and a value stamped earlier
 * spends part of it in a queue.
 */
export type SlackNoticeEmission = {
  readonly useCase: string;
  /** The receiver's dedup key. Must be stable across a retry of this post. */
  readonly deliveryId: string;
  readonly text: string;
  readonly links?: readonly SlackNoticeLink[];
  readonly run?: string;
  readonly executionId?: string;
};

/**
 * The signed body. Deliberately NOT `SlackVerdictPayload`: that one carries a
 * `SlackOrigin` because it answers a request that came from a thread. This is
 * the other shape — no thread, no asker, so the destination is the receiver's
 * to decide and `text` arrives without markup baked into it.
 */
export type SlackNoticePayload = {
  readonly version: 1;
  readonly useCase: string;
  readonly deliveryId: string;
  readonly sentAt: number;
  readonly text: string;
  readonly links?: readonly SlackNoticeLink[];
  readonly run?: string;
  readonly executionId?: string;
};

/** Build the notice body. Pure — the clock is an argument, not a call. */
export const renderSlackNotice = (
  emission: SlackNoticeEmission,
  sentAt: number,
): SlackNoticePayload => ({
  version: 1,
  useCase: emission.useCase,
  deliveryId: emission.deliveryId,
  sentAt,
  text: emission.text,
  ...(emission.links !== undefined && emission.links.length > 0 ? { links: emission.links } : {}),
  ...(emission.run !== undefined ? { run: emission.run } : {}),
  ...(emission.executionId !== undefined ? { executionId: emission.executionId } : {}),
});

/**
 * The receiver's shape rules, applied before we spend a request on them.
 * Returns the reason it would be refused, or `undefined` when it is sendable.
 *
 * This is a MIRROR, not a second opinion: the receiver re-checks all of it and
 * its answer wins. What checking here buys is a legible failure — "text is
 * 14203 chars, the cap is 12000" in our own log, instead of a 400 whose body
 * nobody reads because a notice failing is (correctly) never fatal.
 */
export const validateSlackNotice = (payload: SlackNoticePayload): string | undefined => {
  if (!NOTICE_USE_CASE.test(payload.useCase)) {
    return `useCase "${payload.useCase}" must match ${NOTICE_USE_CASE.source}`;
  }
  if (!NOTICE_DELIVERY_ID.test(payload.deliveryId)) {
    return `deliveryId "${payload.deliveryId}" must match ${NOTICE_DELIVERY_ID.source}`;
  }
  if (!Number.isFinite(payload.sentAt)) return "sentAt must be finite epoch milliseconds";
  if (payload.text.trim().length === 0) return "text is empty — an empty notice is not a notice";
  if (payload.text.length > MAX_NOTICE_TEXT_CHARS) {
    return `text is ${payload.text.length} chars; the cap is ${MAX_NOTICE_TEXT_CHARS}`;
  }
  if (payload.run !== undefined && !NOTICE_RUN_NAME.test(payload.run)) {
    return `run "${payload.run}" must match ${NOTICE_RUN_NAME.source}`;
  }
  if (payload.executionId !== undefined && !NOTICE_DELIVERY_ID.test(payload.executionId)) {
    return `executionId "${payload.executionId}" must match ${NOTICE_DELIVERY_ID.source}`;
  }
  const links = payload.links ?? [];
  if (links.length > MAX_NOTICE_LINKS) {
    return `${links.length} links; the cap is ${MAX_NOTICE_LINKS}`;
  }
  for (const link of links) {
    // https only, and no character that could close the `<url|label>` span the
    // receiver renders or smuggle a second one into it.
    if (!link.url.startsWith("https://") || link.url.length > MAX_NOTICE_URL_CHARS) {
      return `link url must be https:// and at most ${MAX_NOTICE_URL_CHARS} chars`;
    }
    // The receiver refuses control characters in a link url by exactly this
    // class; mirroring it is the point.
    // oxlint-disable-next-line no-control-regex
    if (/[<>|\s]|[\u0000-\u001f]/.test(link.url)) {
      return "link url must not contain <, >, |, whitespace or control characters";
    }
    if (link.label.trim().length === 0 || link.label.length > MAX_NOTICE_LABEL_CHARS) {
      return `link label must be 1-${MAX_NOTICE_LABEL_CHARS} non-blank chars`;
    }
    // STRICTER than the receiver, deliberately — see NOTICE_LABEL_FORBIDDEN.
    if (NOTICE_LABEL_FORBIDDEN.test(link.label)) {
      return "link label must not contain <, > or | (it is rendered inside a `<url|label>` span)";
    }
  }
  return undefined;
};

// --- Config resolution -------------------------------------------------------

/**
 * The keying material for both signatures: a dedicated `SLACK_NOTIFY_SECRET`
 * when set, else `HMAC_SECRET`. `undefined` only when neither exists — the
 * callback is then skipped rather than sent unsigned.
 *
 * One secret for both surfaces, two keys out of it. The verdict callback and
 * the notice derive under different HKDF labels
 * (`SLACK_NOTIFY_HKDF_INFO` / `SLACK_NOTICE_HKDF_INFO`), so they are already
 * independent keys to the receiver — a leaked notice key cannot sign a verdict,
 * which is the shape that names a channel. A second SECRET would add a second
 * thing to rotate and keep in sync for separation HKDF has already given.
 */
export const resolveSlackNotifySecret = (env: Env): string | undefined => {
  const dedicated = env.SLACK_NOTIFY_SECRET;
  if (typeof dedicated === "string" && dedicated.length > 0) return dedicated;
  const hmac = env.HMAC_SECRET;
  if (typeof hmac === "string" && hmac.length > 0) return hmac;
  return undefined;
};

/**
 * CONFIG_KV first, then the wrangler var — the slack-origin config precedence.
 *
 * **https only.** Both callbacks carry an HMAC over the body in a header, and
 * `http://` would put that signature and the payload on the wire in clear for
 * anyone on the path to read and replay. A misconfigured endpoint degrades to
 * "no callback attempted", which is the same best-effort silence as an unset
 * key — the wrong destination is not worth a leaked signature.
 */
const readUrl = async (
  env: Env,
  kvKey: string,
  fromVar: string | undefined,
): Promise<string | undefined> => {
  const configured = env.CONFIG_KV === undefined ? null : await env.CONFIG_KV.get(kvKey);
  const chosen =
    typeof configured === "string" && configured.trim().length > 0
      ? configured.trim()
      : typeof fromVar === "string" && fromVar.trim().length > 0
        ? fromVar.trim()
        : undefined;
  if (chosen === undefined) return undefined;
  return chosen.startsWith("https://") ? chosen : undefined;
};

/**
 * The verdict callback endpoint for this deploy. `undefined` ⇒ no callback is
 * attempted.
 */
export const readSlackNotifyUrl = (env: Env): Promise<string | undefined> =>
  readUrl(env, SLACK_NOTIFY_URL_KEY, env.SLACK_NOTIFY_URL);

/**
 * The notice ingress endpoint for this deploy. Separate key — see
 * `SLACK_NOTICE_URL_KEY`. `undefined` ⇒ notices are a logged no-op.
 */
export const readSlackNoticeUrl = (env: Env): Promise<string | undefined> =>
  readUrl(env, SLACK_NOTICE_URL_KEY, env.SLACK_NOTICE_URL);

// --- Delivery ----------------------------------------------------------------

/** A signed POST that happened, or a reason it did not. */
type SignedPost =
  | { readonly sent: true; readonly status: number }
  | { readonly sent: false; readonly reason: string };

/**
 * Sign the exact bytes and POST them. Never throws: a non-2xx, a network error
 * and a timeout all come back as data.
 *
 * The body is serialized ONCE and both the MAC and the request see the same
 * `Uint8Array`. Re-stringifying for the request would open the one gap the
 * raw-bytes canonicalization exists to close.
 *
 * `redirect: "manual"` because a followed redirect replays the body AND the
 * `X-FlareDispatch-Signature` header to an origin the receiver chose, not the
 * one an operator configured — a signed payload delivered somewhere nobody
 * approved. A 3xx therefore reads as a non-2xx and is logged like any other
 * refusal; a receiver that wants to move endpoints changes the config key.
 */
const postSigned = async (opts: {
  readonly url: string;
  readonly secret: string;
  /**
   * The HKDF label to derive under. Required, with no default: a default would
   * silently be the wrong one for whichever surface forgot to pass it, and the
   * failure mode is a 401 nobody reads.
   */
  readonly hkdfInfo: string;
  readonly payload: unknown;
  readonly fetchImpl?: typeof fetch;
}): Promise<SignedPost> => {
  const body = new TextEncoder().encode(JSON.stringify(opts.payload));
  const key = await deriveSecret(opts.secret, opts.hkdfInfo);
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
      redirect: "manual",
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    return { sent: true, status: response.status };
  } catch (cause) {
    return {
      sent: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
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
  const posted = await postSigned({ ...opts, hkdfInfo: SLACK_NOTIFY_HKDF_INFO });
  if (!posted.sent) return { delivered: false, reason: posted.reason };
  if (posted.status < 200 || posted.status >= 300) {
    return { delivered: false, reason: `callback answered ${posted.status}` };
  }
  return { delivered: true, status: posted.status };
};

/**
 * What one notice attempt did. The vocabulary is the receiver's own
 * (`posted` / `duplicate` / `failed`, plus a local `skipped`) so the two halves
 * describe the same events with the same words.
 */
export type SlackNoticeOutcome =
  | { readonly outcome: "posted"; readonly status: number }
  | { readonly outcome: "duplicate" }
  | { readonly outcome: "skipped"; readonly reason: string }
  | { readonly outcome: "failed"; readonly reason: string };

/**
 * Sign and POST one notice. Never throws.
 *
 * A 409 is `duplicate`, not a failure. Treating it as an error would make a
 * retried Workflow step look broken for behaving correctly.
 *
 * This reading rests on one receiver obligation: **409 is reserved for an id it
 * actually delivered**, never for one it merely claimed and has not posted. A
 * receiver that answers 409 for an unposted claim turns a crash between claim
 * and post into a silence with a success beside it. The contract, and the
 * `claimed` / `delivered` split it requires, is in `specs/slack-origin.md`
 * § At most once, across a retry.
 *
 * `duplicate` is deliberately NOT `delivered` in the capability's result — see
 * runtime-cf `notice-cf.ts`. Nothing here witnessed a post, so nothing here
 * claims one.
 */
export const deliverSlackNotice = async (opts: {
  readonly url: string;
  readonly secret: string;
  readonly payload: SlackNoticePayload;
  readonly fetchImpl?: typeof fetch;
}): Promise<SlackNoticeOutcome> => {
  const invalid = validateSlackNotice(opts.payload);
  if (invalid !== undefined) return { outcome: "failed", reason: invalid };

  const posted = await postSigned({ ...opts, hkdfInfo: SLACK_NOTICE_HKDF_INFO });
  if (!posted.sent) return { outcome: "failed", reason: posted.reason };
  if (posted.status === 409) return { outcome: "duplicate" };
  if (posted.status < 200 || posted.status >= 300) {
    return { outcome: "failed", reason: `notice ingress answered ${posted.status}` };
  }
  return { outcome: "posted", status: posted.status };
};

/**
 * The whole emit path for a notice, from `env` to an outcome — the single
 * entry point the `notice` capability's live Layer calls.
 *
 * Config is resolved HERE, per call, rather than when the runtime Layer is
 * built: most executions never publish anything, and a KV read on every one of
 * them to answer a question almost none of them ask is a cost with no payer.
 *
 * The credential never leaves this module. runtime-cf receives a closure over
 * this function, not the secret — the same seam `signMailboxToken` uses, and
 * the reason ADR-0006 can say the keying material stays in the Worker's own
 * environment.
 */
export const emitSlackNotice = async (
  env: Env,
  emission: SlackNoticeEmission,
  opts: { readonly now?: () => number; readonly fetchImpl?: typeof fetch } = {},
): Promise<SlackNoticeOutcome> => {
  const url = await readSlackNoticeUrl(env);
  const secret = resolveSlackNotifySecret(env);
  if (url === undefined) {
    return {
      outcome: "skipped",
      reason: `no notice ingress configured (CONFIG_KV ${SLACK_NOTICE_URL_KEY} / SLACK_NOTICE_URL)`,
    };
  }
  if (secret === undefined) {
    return {
      outcome: "skipped",
      reason: "no signing key (SLACK_NOTIFY_SECRET / HMAC_SECRET)",
    };
  }
  // Stamped here, immediately before signing — the receiver's window is ±5
  // minutes and it measures from this value, which the signature covers.
  const sentAt = (opts.now ?? Date.now)();
  return deliverSlackNotice({
    url,
    secret,
    payload: renderSlackNotice(emission, sentAt),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });
};
