// @fractalbox/flare-dispatch-github-app — GitHub App JWT signer.
//
// A GitHub App authenticates to `/app/*` endpoints with a short-lived JWT
// signed RS256 with the App's PEM private key. This module produces that JWT
// using only `crypto.subtle` — no Node `crypto`, no `jsonwebtoken` dependency —
// so it runs unchanged on the Cloudflare Workers runtime.
//
// Claims (GitHub's requirements, https://docs.github.com/apps/...):
//   * `iat` — issued-at; backdated 60 s to tolerate clock skew between the
//     Worker and GitHub.
//   * `exp` — expiry; GitHub rejects anything more than 10 min out, so we cap
//     the lifetime well under that (default 9 min from the *un-backdated* now).
//   * `iss` — the numeric App id.
//
// Spec: specs/04-gha-integration.md § Check-runs callback, specs/05-byoc.md
// § Secrets (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY).

/** GitHub caps App-JWT lifetime at 10 minutes; stay safely under it. */
const MAX_JWT_LIFETIME_SEC = 9 * 60;

/** Backdate `iat` to absorb clock skew between the Worker and GitHub. */
const CLOCK_SKEW_SEC = 60;

/** base64url-encode a byte array (no padding) — the JWT segment encoding. */
const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** base64url-encode a UTF-8 string — used for the JWT header + claim set. */
const base64urlText = (text: string): string =>
  base64url(new TextEncoder().encode(text));

/**
 * Decode a PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----` … ) into raw DER bytes.
 * GitHub App private keys are issued in PKCS#1 (`BEGIN RSA PRIVATE KEY`); the
 * App settings page also offers a PKCS#8 export. `crypto.subtle.importKey`
 * only accepts PKCS#8, so a PKCS#1 key must be converted before use (the App
 * setup doc instructs the operator to export PKCS#8). We accept either header
 * but require the body to be PKCS#8 DER.
 */
const pemToDer = (pem: string): Uint8Array => {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) der[i] = binary.charCodeAt(i);
  return der;
};

/** Import a PKCS#8 PEM as an RSASSA-PKCS1-v1_5 / SHA-256 signing key. */
const importSigningKey = (pem: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "pkcs8",
    // `BufferSource` over the DER bytes — slice() yields a plain ArrayBuffer.
    pemToDer(pem).slice().buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

/** Options for {@link signAppJwt}. */
export type SignAppJwtOptions = {
  /** The numeric GitHub App id (`GITHUB_APP_ID`). */
  readonly appId: string | number;
  /** The App's PKCS#8 PEM private key (`GITHUB_APP_PRIVATE_KEY`). */
  readonly privateKeyPem: string;
  /** Override "now" (seconds) — test seam; defaults to `Date.now()`. */
  readonly nowSec?: number;
  /** JWT lifetime in seconds; clamped to GitHub's 10-min ceiling. */
  readonly lifetimeSec?: number;
};

/**
 * Sign a GitHub App JWT (RS256). The result is a standard three-segment JWT
 * (`header.payload.signature`, all base64url) suitable for the
 * `Authorization: Bearer <jwt>` header on `/app/*` endpoints.
 */
export const signAppJwt = async (opts: SignAppJwtOptions): Promise<string> => {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const lifetimeSec = Math.min(
    opts.lifetimeSec ?? MAX_JWT_LIFETIME_SEC,
    MAX_JWT_LIFETIME_SEC,
  );

  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iat: nowSec - CLOCK_SKEW_SEC,
    exp: nowSec + lifetimeSec,
    iss: String(opts.appId),
  };

  const signingInput = `${base64urlText(JSON.stringify(header))}.${base64urlText(
    JSON.stringify(claims),
  )}`;

  const key = await importSigningKey(opts.privateKeyPem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
};
