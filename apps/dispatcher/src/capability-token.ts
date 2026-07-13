// FlareDispatch Dispatcher — HKDF-derived, per-execution capability tokens.
//
// Two surfaces mint these: the log-viewer (`log-token.ts`) and the agent
// model-proxy (`agent-token.ts`). Both share the SAME construction —
//
//   token = base64url( HMAC-SHA256( k, executionId ) )[0..22)          // 132 bits
//   k     = HKDF-SHA256( ikm, salt="", info=<namespace label> )
//
// — and differ ONLY in the HKDF `info` label. That label is load-bearing: it
// domain-separates the two namespaces so a token minted for one surface can
// never be confused with, or forged from, the other even when both derive from
// the same `HMAC_SECRET`. Each caller passes its own distinct label to
// `makeCapabilityToken`; the crypto pipeline lives here, once.

const encoder = new TextEncoder();

/** Token length in base64url chars — 22 chars ≈ 132 bits, ample for a cap. */
const TOKEN_CHARS = 22;

/** base64url (no padding) of a byte buffer. */
const base64url = (bytes: ArrayBuffer): string => {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Constant-time-ish equality for equal-length token strings. */
const safeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/**
 * Derive the HMAC signing key from the input keying material, domain-separated
 * by `info`. No per-token salt: the label provides domain separation and the
 * execution id is the signed message, so a fixed (empty) salt is correct here.
 */
const deriveKey = async (ikm: string, info: string): Promise<CryptoKey> => {
  const base = await crypto.subtle.importKey(
    "raw",
    encoder.encode(ikm),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: encoder.encode(info),
    },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
};

/** A sign/verify pair for one capability namespace (identified by its label). */
export interface CapabilityToken {
  /** Mint the capability token for `executionId` under the given key material. */
  readonly sign: (ikm: string, executionId: string) => Promise<string>;
  /**
   * Verify a presented token for `executionId` — recomputes the expected token
   * and compares constant-time. `false` for a missing/short token or any
   * mismatch.
   */
  readonly verify: (
    ikm: string,
    executionId: string,
    presented: string | null | undefined,
  ) => Promise<boolean>;
}

/**
 * Build the sign/verify pair for one capability namespace. `hkdfInfo` is the
 * domain-separation label — it MUST be distinct per namespace (see file header).
 */
export const makeCapabilityToken = (hkdfInfo: string): CapabilityToken => {
  const sign = async (ikm: string, executionId: string): Promise<string> => {
    const key = await deriveKey(ikm, hkdfInfo);
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(executionId) as BufferSource,
    );
    return base64url(mac).slice(0, TOKEN_CHARS);
  };
  const verify = async (
    ikm: string,
    executionId: string,
    presented: string | null | undefined,
  ): Promise<boolean> => {
    if (typeof presented !== "string" || presented.length !== TOKEN_CHARS) {
      return false;
    }
    const expected = await sign(ikm, executionId);
    return safeEqual(expected, presented);
  };
  return { sign, verify };
};
