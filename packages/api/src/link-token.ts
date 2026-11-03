// Link tokens: the capability a log or artifact link carries in place of an Access identity (FD-IFC-017 to
// FD-IFC-022). A token is `<expiry>.<epoch>.<mac>`, where `mac` is HMAC-SHA256 over the purpose, the object id, the
// expiry and the revocation epoch, under a key HKDF derives from the link key with one label per purpose, truncated to
// 128 bits and base64url encoded.
import { base64urlEncode, constantTimeEqual, hkdfSha256, hmacSha256 } from "./crypto.ts";

/** What a token grants: one execution's logs, or one artifact. */
export type LinkPurpose = "logs" | "artifact";

/** The HKDF label of each purpose; a key derived for one purpose verifies no token of another. */
export const LINK_LABELS: Readonly<Record<LinkPurpose, string>> = {
  logs: "flare-dispatch/link/logs/v1",
  artifact: "flare-dispatch/link/artifact/v1",
};

/** 16 bytes: the 128-bit floor of FD-IFC-018. */
const MAC_BYTES = 16;

const macOf = async (
  linkKey: string,
  purpose: LinkPurpose,
  objectId: string,
  expiresAtS: number,
  epoch: number,
): Promise<string> => {
  const key = await hkdfSha256(linkKey, LINK_LABELS[purpose]);
  const mac = await hmacSha256(key, `${purpose}\n${objectId}\n${expiresAtS}\n${epoch}`);
  return base64urlEncode(mac.slice(0, MAC_BYTES));
};

export interface LinkGrant {
  readonly purpose: LinkPurpose;
  /** The execution id for `logs`, the artifact id for `artifact`. */
  readonly objectId: string;
  /** Unix seconds. */
  readonly expiresAtS: number;
  readonly epoch: number;
}

export const mintLinkToken = async (linkKey: string, grant: LinkGrant): Promise<string> =>
  `${grant.expiresAtS}.${grant.epoch}.${await macOf(
    linkKey,
    grant.purpose,
    grant.objectId,
    grant.expiresAtS,
    grant.epoch,
  )}`;

export type LinkCheck =
  | { readonly _tag: "Granted" }
  | { readonly _tag: "Expired" }
  | { readonly _tag: "Revoked" }
  | { readonly _tag: "Invalid" };

/**
 * Checks a presented token for one object. The MAC is checked first, so an expiry or an epoch a caller edits never
 * reaches the expiry and epoch answers.
 */
export const checkLinkToken = async (
  linkKey: string,
  token: string,
  request: {
    readonly purpose: LinkPurpose;
    readonly objectId: string;
    readonly nowS: number;
    readonly currentEpoch: number;
  },
): Promise<LinkCheck> => {
  const match = /^(\d{1,12})\.(\d{1,9})\.([A-Za-z0-9_-]{22,})$/.exec(token);
  if (match === null) return { _tag: "Invalid" };
  const expiresAtS = Number(match[1]);
  const epoch = Number(match[2]);
  const expected = await macOf(linkKey, request.purpose, request.objectId, expiresAtS, epoch);
  if (!(await constantTimeEqual(match[3], expected))) return { _tag: "Invalid" };
  if (epoch < request.currentEpoch) return { _tag: "Revoked" };
  if (request.nowS >= expiresAtS) return { _tag: "Expired" };
  return { _tag: "Granted" };
};
