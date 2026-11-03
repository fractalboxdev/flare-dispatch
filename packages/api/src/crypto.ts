// The Web Crypto primitives the identity gates and link tokens share. Every comparison of a token or a MAC runs in
// constant time (FD-IFC-022): both sides collapse to a MAC under a fresh random key, and `crypto.subtle.verify`
// compares those, so neither a length nor a prefix of a guess is observable.
const encoder = new TextEncoder();

export const utf8 = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(encoder.encode(text));

export const base64urlEncode = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Decodes base64url, or answers `undefined` for text outside the alphabet or of an impossible length. */
export const base64urlDecode = (text: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
  const padded =
    text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
};

/** Constant-time equality of two strings; an empty or absent side is never equal. */
export const constantTimeEqual = async (
  a: string | null | undefined,
  b: string | null | undefined,
): Promise<boolean> => {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0)
    return false;
  const key = await crypto.subtle.importKey(
    "raw",
    crypto.getRandomValues(new Uint8Array(32)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const macA = await crypto.subtle.sign("HMAC", key, utf8(a));
  return crypto.subtle.verify("HMAC", key, macA, utf8(b));
};

/** HMAC-SHA256 of `data` under raw key bytes. */
export const hmacSha256 = async (
  key: Uint8Array<ArrayBuffer>,
  data: string,
): Promise<Uint8Array> => {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, utf8(data)));
};

/** HKDF-SHA256 of `ikm` with an empty salt and `info` as the label, 32 bytes out. */
export const hkdfSha256 = async (ikm: string, info: string): Promise<Uint8Array<ArrayBuffer>> => {
  const base = await crypto.subtle.importKey("raw", utf8(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(info) },
    base,
    256,
  );
  return new Uint8Array(bits);
};

export const sha256Hex = async (text: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text))))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
