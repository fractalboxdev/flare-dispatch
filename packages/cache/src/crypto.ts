// Hashing, canonical JSON, base64url and the HKDF-derived HMAC keys the capability tokens sign with. Web Crypto
// only, so the same code runs in workerd and in Node.

const encoder = new TextEncoder();

export const utf8 = (text: string): Uint8Array => encoder.encode(text);

export const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

const asBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** Lowercase hex SHA-256 of `input`. */
export const sha256Hex = async (input: string | Uint8Array): Promise<string> =>
  hex(
    await crypto.subtle.digest("SHA-256", asBuffer(typeof input === "string" ? utf8(input) : input)),
  );

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit at every depth, no whitespace, `undefined` members dropped.
 * The cache key hashes it, so two writers with the same fields compute the same key whatever their key order.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
};

export const base64url = (bytes: Uint8Array | ArrayBuffer): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** The bytes of a base64url string, or `undefined` when it is not one. */
export const fromBase64url = (text: string): Uint8Array | undefined => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  try {
    return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
};

/** The key `crypto.subtle.importKey` answers, named without the `CryptoKey` global so Node-only consumers type-check. */
type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/**
 * An HMAC-SHA256 key derived from `secret` with HKDF-SHA256 under the domain-separation `label`, so a token of one
 * kind never verifies as another kind even though every kind derives from the same Worker secret.
 */
export const derivedHmacKey = async (secret: string, label: string): Promise<HmacKey> => {
  const ikm = await crypto.subtle.importKey("raw", asBuffer(utf8(secret)), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: asBuffer(utf8(label)) },
    ikm,
    256,
  );
  return crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
};

export const hmacSign = async (key: HmacKey, message: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.sign("HMAC", key, asBuffer(utf8(message))));

/** `crypto.subtle.verify` compares the MAC in constant time. */
export const hmacVerify = (key: HmacKey, mac: Uint8Array, message: string): Promise<boolean> =>
  crypto.subtle.verify("HMAC", key, asBuffer(mac), asBuffer(utf8(message)));

/** 128 bits from the platform's cryptographically secure generator, as 32 lowercase hex characters. */
export const random128 = (): string => hex(crypto.getRandomValues(new Uint8Array(16)));

export { asBuffer };
