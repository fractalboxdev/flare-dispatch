// HMAC-SHA256 request signatures in the `sha256=<hex>` form GitHub's `X-Hub-Signature-256` uses. The signature covers
// the raw body bytes exactly as received, with no JSON parse or re-serialization, so a route verifies before it parses.
// `crypto.subtle.verify` compares in constant time (FD-IFC-022).
import { utf8 } from "./crypto.ts";

const PREFIX = "sha256=";

const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> | undefined => {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const bytesToHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const importKey = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);

const bodyBytes = (body: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> =>
  body instanceof Uint8Array ? new Uint8Array(body) : new Uint8Array(body);

/** The `sha256=<hex>` signature of the raw body bytes. */
export const signBody = async (secret: string, body: ArrayBuffer | Uint8Array): Promise<string> =>
  `${PREFIX}${bytesToHex(await crypto.subtle.sign("HMAC", await importKey(secret, "sign"), bodyBytes(body)))}`;

/** True only for a well-formed `sha256=<hex>` header whose 32-byte MAC matches the raw body bytes. */
export const verifyBody = async (
  secret: string,
  header: string | null | undefined,
  body: ArrayBuffer | Uint8Array,
): Promise<boolean> => {
  if (typeof header !== "string" || !header.startsWith(PREFIX)) return false;
  const mac = hexToBytes(header.slice(PREFIX.length));
  if (mac === undefined || mac.length !== 32) return false;
  return crypto.subtle.verify("HMAC", await importKey(secret, "verify"), mac, bodyBytes(body));
};
