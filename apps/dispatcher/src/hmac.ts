// FlareDispatch Dispatcher — HMAC-SHA256 request verification.
//
// --- Canonicalization: RAW BYTES, NO NORMALIZATION ---------------------------
//
// specs/04-gha-integration.md § Dispatch body and specs/05-byoc.md § Secrets
// both reference `HMAC_SECRET` but neither pins what gets signed. This file
// LOCKS the contract per specs/pm/plan.md § 6 ("HMAC verification surface"):
//
//   The signature is computed over the RAW REQUEST BODY BYTES EXACTLY AS
//   RECEIVED — the byte sequence read off `Request.arrayBuffer()`. There is NO
//   JSON parse/re-serialize, no key reordering, no whitespace canonicalization,
//   no charset transcoding. The signer (the GHA `dispatch.sh`) pipes the exact
//   bytes it POSTs through `openssl dgst -sha256 -hmac "$HMAC_SECRET"`; the
//   Worker verifies the exact bytes it received. Both sides see the same
//   octets, so the MAC matches without either side agreeing on a canonical
//   JSON form. The dispatch route therefore reads the body ONCE as raw bytes,
//   verifies, and only then parses — never the reverse.
//
// --- Constant-time comparison ------------------------------------------------
//
// Verification uses `crypto.subtle.verify("HMAC", key, sig, data)` (specs/
// 05-byoc.md § Security posture). `crypto.subtle.verify` is constant-time and
// is the ONLY supported primitive on Workers — Node's `crypto.timingSafeEqual`
// is not in the Workers runtime and must not be used. We never hand-roll a
// hex-string comparison: that would leak timing.
//
// --- Header format -----------------------------------------------------------
//
//   X-FlareDispatch-Signature: sha256=<hex>
//
// The `sha256=` prefix is mandatory; `<hex>` is the lowercase hex encoding of
// the 32-byte HMAC. A missing/malformed header fails verification (→ 401 at
// the route layer) — it is never treated as "unsigned, allow".

/** The header carrying the request signature. */
export const SIGNATURE_HEADER = "X-FlareDispatch-Signature";

/** Required prefix on the signature header value. */
const SIGNATURE_PREFIX = "sha256=";

const encoder = new TextEncoder();

/** Decode a lowercase/uppercase hex string to bytes; `null` if malformed. */
const hexToBytes = (hex: string): Uint8Array | null => {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
};

/** Lowercase hex encoding of a byte buffer. */
const bytesToHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** Import the shared secret as an HMAC-SHA256 CryptoKey. */
const importKey = (
  secret: string,
  usages: ("sign" | "verify")[],
): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );

/**
 * Sign raw body bytes — returns the `sha256=<hex>` header value. Used by tests
 * (and any in-process caller) to produce a signature the verifier accepts.
 */
export const sign = async (
  secret: string,
  body: ArrayBuffer | Uint8Array,
): Promise<string> => {
  const key = await importKey(secret, ["sign"]);
  const data = body instanceof Uint8Array ? body : new Uint8Array(body);
  const mac = await crypto.subtle.sign("HMAC", key, data as BufferSource);
  return `${SIGNATURE_PREFIX}${bytesToHex(mac)}`;
};

/**
 * Non-secret fingerprint of the HMAC secret — `sha256(secret)[:8]`, lowercase
 * hex. Same shape as a git short-SHA: enough bits to disambiguate two secrets,
 * useless as a credential. Surfaced in 401 bodies (and any future health
 * surface) so an operator can compare caller-vs-dispatcher fingerprints during
 * drift diagnosis. Sensitive to whitespace — a trailing `\n` smuggled in by
 * `wrangler secret put` flips the fingerprint, which is the dominant failure
 * mode this primitive exists to catch (issue #24).
 */
export const fingerprint = async (secret: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return bytesToHex(digest).slice(0, 8);
};

/**
 * Constant-time equality of two strings — for comparing a presented bearer
 * token against a configured one (signal ingress, `routes/signals-webhook.ts`).
 *
 * Workers has no `crypto.timingSafeEqual`. We HMAC BOTH strings under the same
 * freshly-minted random key, then compare the fixed-width (32-byte) MACs via
 * `crypto.subtle.verify` (which IS constant-time). This is timing-safe AND
 * length-safe: a length difference no longer short-circuits, because both
 * inputs collapse to a 32-byte MAC before any comparison, and the per-call
 * random key means an attacker can't precompute or correlate the MAC of a guess
 * across calls. Returns `false` for any nullish/empty input (fail closed).
 */
export const constantTimeEqual = async (
  a: string | null | undefined,
  b: string | null | undefined,
): Promise<boolean> => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length === 0 || b.length === 0) return false;
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const macA = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(a) as BufferSource,
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    macA as BufferSource,
    encoder.encode(b) as BufferSource,
  );
};

/**
 * Constant-time verify of a `X-FlareDispatch-Signature` header value against
 * the raw request body bytes.
 *
 * @param secret  the shared `HMAC_SECRET`.
 * @param header  the raw header value (`null` when absent) — must be
 *                `sha256=<hex>`.
 * @param body    the raw request body bytes, exactly as received.
 * @returns `true` iff the signature is well-formed AND matches.
 */
export const verify = async (
  secret: string,
  header: string | null | undefined,
  body: ArrayBuffer | Uint8Array,
): Promise<boolean> => {
  if (typeof header !== "string" || !header.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }
  const sigBytes = hexToBytes(header.slice(SIGNATURE_PREFIX.length));
  // A SHA-256 HMAC is always 32 bytes; reject anything else before the
  // (constant-time) verify so a length mismatch can't even reach it.
  if (sigBytes === null || sigBytes.length !== 32) return false;

  const key = await importKey(secret, ["verify"]);
  const data = body instanceof Uint8Array ? body : new Uint8Array(body);
  return crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes as BufferSource,
    data as BufferSource,
  );
};
