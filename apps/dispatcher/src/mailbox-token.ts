// FlareDispatch Dispatcher — EXPIRING mailbox-read capability tokens.
//
// The mailbox-read surface (`/v1/mailbox/:localPart`) serves the messages
// delivered to a provisioned inbox — which, for an email-OTP provisioning flow,
// is a CREDENTIAL channel: the one-time codes and magic links that grant
// access to whatever third-party account the inbox was registered against. A
// token that hands out those messages is materially more sensitive than the
// log-viewer link, and it lives somewhere worse: baked into a container's
// environment, where it can leak via a `set -x` trace, an env dump, or a
// compromised dependency.
//
// So this token MIRRORS the `log-token.ts` construction (HKDF-derived,
// domain-separated, constant-time-compared) but ADDS a hard expiry BOUND INTO
// THE SIGNED PAYLOAD —
//
//   message = `${localPart}|${expEpochS}`
//   token   = base64url( HMAC-SHA256( k_mailbox, message ) )[0..22)   // 132 bits
//   k_mbox  = HKDF-SHA256( ikm, salt="", info="flare-dispatch/mailbox-link/v1" )
//
// Why the expiry must be IN the signed message, not a side-channel: a reviewer
// flagged the non-expiring log-token construction as wrong for this
// credential-bearing route. If the lifetime were a separate unsigned `?exp=`
// query param, a holder of a leaked token could simply rewrite it to push the
// deadline out — the MAC wouldn't change because it wouldn't cover the deadline.
// By signing `localPart|expEpochS`, the expiry is tamper-evident: change the
// `exp` and the MAC no longer verifies. And `verify` checks the clock BEFORE the
// HMAC compare, so an expired token is invalid even if its MAC still matches —
// a leaked container-env token is dead the moment its window closes, no
// revocation list required.
//
// --- Key material: MAILBOX_LINK_SECRET, falling back to HMAC_SECRET ----------
//
// `ikm` prefers a dedicated `MAILBOX_LINK_SECRET` so mailbox links can be
// ROTATED INDEPENDENTLY of the dispatch HMAC: rotating this secret kills every
// outstanding mailbox token at once (the right blast-radius control for a
// credential surface) without disturbing in-flight dispatch verification. When
// unset it falls back to `HMAC_SECRET` — which every Action-mode deploy already
// provisions — so the route is tokened-by-default with no new repo secret. The
// HKDF `info` label domain-separates `k_mailbox` from both the dispatch HMAC and
// the log-link key, so a token minted for one surface can never be confused
// with, or forged from, another even when all three share input keying material.

import { makeCapabilityToken } from "./capability-token";
import type { Env } from "./env";

/** HKDF `info` label — domain-separates `k_mailbox` from the dispatch HMAC and the log-link key. */
const HKDF_INFO = "flare-dispatch/mailbox-link/v1";

const token = makeCapabilityToken(HKDF_INFO);

/**
 * The signed message binds BOTH the mailbox local-part AND the expiry, so the
 * MAC covers the deadline and a holder cannot extend the window without
 * invalidating the token. `expEpochS` is whole seconds since the Unix epoch.
 */
const message = (localPart: string, expEpochS: number): string =>
  `${localPart}|${expEpochS}`;

/**
 * Mint an expiring mailbox-read token for `localPart`, valid until `expEpochS`
 * (Unix seconds). The expiry is part of the signed payload — see file header.
 */
export const signMailboxToken = (
  ikm: string,
  localPart: string,
  expEpochS: number,
): Promise<string> => token.sign(ikm, message(localPart, expEpochS));

/**
 * Verify a presented mailbox token for `localPart` at deadline `expEpochS`,
 * given the current time `nowS` (Unix seconds). The expiry is checked BEFORE the
 * HMAC compare: a token whose window has closed (`nowS > expEpochS`), or whose
 * `expEpochS` is not a finite number, is rejected even if its MAC would match.
 * `false` for a missing/short token or any mismatch.
 */
export const verifyMailboxToken = async (
  ikm: string,
  localPart: string,
  expEpochS: number,
  presented: string | null | undefined,
  nowS: number,
): Promise<boolean> => {
  if (!Number.isFinite(expEpochS) || nowS > expEpochS) return false;
  return token.verify(ikm, message(localPart, expEpochS), presented);
};

/**
 * The keying material for mailbox tokens: a dedicated `MAILBOX_LINK_SECRET` if
 * set, else `HMAC_SECRET`. `undefined` only when neither is present (→ the
 * route default-denies). Empty strings are treated as unset. A dedicated secret
 * lets mailbox links rotate independently of the dispatch HMAC (file header).
 */
export const resolveMailboxLinkSecret = (env: Env): string | undefined => {
  const dedicated = env.MAILBOX_LINK_SECRET;
  if (typeof dedicated === "string" && dedicated.length > 0) return dedicated;
  const hmac = env.HMAC_SECRET;
  if (typeof hmac === "string" && hmac.length > 0) return hmac;
  return undefined;
};

/**
 * Build the tokened mailbox-read URL. The route keys on the `localPart` (the
 * allocations key), so that — not the full address — is what goes in the path;
 * `exp` and `t` ride as query params and are both covered by the signed payload
 * (`exp`) or are the payload's MAC (`t`). `origin` is the dispatcher's public
 * origin (any trailing slash is stripped).
 */
export const buildMailboxUrl = (
  origin: string,
  localPart: string,
  expEpochS: number,
  token: string,
): string =>
  `${origin.replace(/\/$/, "")}/v1/mailbox/${encodeURIComponent(
    localPart,
  )}?exp=${expEpochS}&t=${token}`;
