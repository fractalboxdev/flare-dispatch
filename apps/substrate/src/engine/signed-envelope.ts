// A domain-separated HMAC envelope: `<domain>.<base64url(claims)>.<hex mac>`.
//
// The MAC covers the exact encoded-claims bytes, so there is no canonicalization
// for a signer and a verifier to disagree on, and the domain prefix is inside
// the signed material — a token minted for one purpose cannot be replayed as
// another even when both derive from the same secret. Verification is
// constant-time via `crypto.subtle.verify`, which is Workers' only supported
// primitive for it; a hex-string compare leaks the MAC one byte at a time.
//
// `admission/ticket.ts` predates this module and carries its own copy of the
// same construction. Collapsing it onto this one is a mechanical follow-up
// deliberately left out of the credential-boundary change — the ticket gate is
// the substrate's fail-closed boot control, and rewriting its internals belongs
// in a change whose subject is the ticket.
//
// Pure WebCrypto (`globalThis.crypto`), zero Cloudflare imports. Unit tested
// through budget/token.test.ts.

const encoder = new TextEncoder();

const importKey = (secret: string, usages: ("sign" | "verify")[]): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );

const bytesToHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

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

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const b64urlDecode = (text: string): Uint8Array | null => {
  try {
    const padded = text.replaceAll("-", "+").replaceAll("_", "/");
    const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};

export type EnvelopeVerdict<C> =
  | { ok: true; claims: C }
  | { ok: false; reason: string };

/**
 * Sign and verify envelopes under one domain label. The label is both the
 * wire-format version prefix and the domain separator, so `"mp1"` and `"v1"`
 * envelopes can never be confused for one another even under the same key.
 */
export function makeEnvelope<C>(domain: string) {
  return {
    async sign(secret: string, claims: C): Promise<string> {
      const payload = encoder.encode(JSON.stringify(claims));
      const key = await importKey(secret, ["sign"]);
      const mac = await crypto.subtle.sign("HMAC", key, payload as BufferSource);
      return `${domain}.${b64url(payload)}.${bytesToHex(mac)}`;
    },

    /**
     * Verify signature and shape only — every claim-level check (expiry, whose
     * execution it is) belongs to the caller, which knows what it expects.
     * Failure is always a reason, never a throw and never a silent pass: a
     * malformed envelope is refused rather than treated as unsigned-allow.
     */
    async open(secret: string, envelope: string | undefined): Promise<EnvelopeVerdict<C>> {
      if (!envelope) return { ok: false, reason: "no token presented" };
      const parts = envelope.split(".");
      const [version, payloadText, macText] = parts;
      if (parts.length !== 3 || version !== domain || !payloadText || !macText)
        return { ok: false, reason: "malformed token" };

      const payload = b64urlDecode(payloadText);
      const mac = hexToBytes(macText);
      if (payload === null || mac === null || mac.length !== 32)
        return { ok: false, reason: "malformed token" };

      const key = await importKey(secret, ["verify"]);
      const valid = await crypto.subtle.verify(
        "HMAC",
        key,
        mac as BufferSource,
        payload as BufferSource,
      );
      if (!valid) return { ok: false, reason: "token failed verification" };

      try {
        return { ok: true, claims: JSON.parse(new TextDecoder().decode(payload)) as C };
      } catch {
        return { ok: false, reason: "malformed token" };
      }
    },
  };
}
