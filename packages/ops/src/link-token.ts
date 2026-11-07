// Link tokens: an HMAC-SHA256 over the purpose, the object id, the expiry and the revocation epoch, under a key HKDF
// derives from the link key with one label per purpose, truncated to 128 bits (FD-IFC-018). A dashboard link expires
// within 3600 s (FD-OPS-067).
import { Effect, Schema } from "effect";

/** What a link token lets its holder read. */
export type LinkPurpose = "log" | "artifact";

/** A dashboard link's lifetime ceiling (FD-OPS-067). */
export const DASHBOARD_LINK_TTL_S = 3600;
const MAC_BYTES = 16;

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromB64url = (s: string): Uint8Array | null => {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};

const purposeKey = async (linkKey: string, purpose: LinkPurpose): Promise<CryptoKey> => {
  const ikm = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(linkKey),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(`flare-dispatch link-token ${purpose}`),
    },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
};

const mac = async (
  linkKey: string,
  purpose: LinkPurpose,
  id: string,
  expiry: number,
  epoch: number,
) => {
  const key = await purposeKey(linkKey, purpose);
  const full = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${purpose}\n${id}\n${expiry}\n${epoch}`),
    ),
  );
  return full.slice(0, MAC_BYTES);
};

/** Constant-time equality of two byte strings (FD-IFC-022). */
export const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};

/** Mints `<expiry>.<epoch>.<mac>` for one object. */
export const mintLinkToken = async (input: {
  readonly linkKey: string;
  readonly purpose: LinkPurpose;
  readonly id: string;
  readonly expiresAt: number;
  readonly epoch: number;
}): Promise<string> =>
  `${input.expiresAt}.${input.epoch}.${b64url(await mac(input.linkKey, input.purpose, input.id, input.expiresAt, input.epoch))}`;

/** The token was refused; the code is the error model's. */
export class LinkRefused extends Schema.TaggedError<LinkRefused>()("LinkRefused", {
  code: Schema.Literals(["forbidden", "link_expired", "link_revoked"]),
}) {}

/** Verifies a token for one object: an unexpired, unrevoked MAC over that object (FD-IFC-017, FD-IFC-020, FD-IFC-021). */
export const verifyLinkToken = (input: {
  readonly linkKey: string;
  readonly purpose: LinkPurpose;
  readonly id: string;
  readonly token: string;
  readonly nowSeconds: number;
  readonly currentEpoch: number;
}) =>
  Effect.gen(function* () {
    const [e, ep, m, ...rest] = input.token.split(".");
    const expiry = Number(e);
    const epoch = Number(ep);
    const given = m === undefined ? null : fromB64url(m);
    if (rest.length > 0 || !Number.isInteger(expiry) || !Number.isInteger(epoch) || given === null)
      return yield* new LinkRefused({ code: "forbidden" });
    const expected = yield* Effect.promise(() =>
      mac(input.linkKey, input.purpose, input.id, expiry, epoch),
    );
    if (!timingSafeEqual(given, expected)) return yield* new LinkRefused({ code: "forbidden" });
    if (expiry <= input.nowSeconds) return yield* new LinkRefused({ code: "link_expired" });
    if (epoch < input.currentEpoch) return yield* new LinkRefused({ code: "link_revoked" });
    return { expiresAt: expiry, epoch };
  });

/** A dashboard link to one log or artifact, its token expiring within 3600 s (FD-OPS-067). */
export const dashboardLink = async (input: {
  readonly linkKey: string;
  readonly purpose: LinkPurpose;
  readonly id: string;
  readonly path: string;
  readonly nowSeconds: number;
  readonly epoch: number;
}): Promise<string> => {
  const token = await mintLinkToken({
    linkKey: input.linkKey,
    purpose: input.purpose,
    id: input.id,
    expiresAt: input.nowSeconds + DASHBOARD_LINK_TTL_S,
    epoch: input.epoch,
  });
  return `${input.path}?t=${encodeURIComponent(token)}`;
};
