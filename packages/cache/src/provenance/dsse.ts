// DSSE envelopes and the provenance key (specs/provenance.md § Keys, § Statement). A statement is an in-toto
// Statement v1 carried as the payload of a DSSE envelope with payload type `application/vnd.in-toto+json`; every
// signature, the device's and the control plane's, is over DSSE's pre-authentication encoding of that payload. The
// control plane signs with the provenance key, an ES256 private JWK with its `kid` held as the `PROVENANCE_KEY` Worker
// secret; a signature's `keyid` is that `kid`, and its `sig` is the standard-base64 IEEE P1363 (r ‖ s) ECDSA value.
import { Option, Schema } from "effect";
import { asBuffer, utf8 } from "../crypto.ts";

export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";

const ES256 = { name: "ECDSA", hash: "SHA-256" } as const;
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

export const DsseSignature = Schema.Struct({ keyid: Schema.String, sig: Schema.String });
export type DsseSignature = typeof DsseSignature.Type;

export const DsseEnvelope = Schema.Struct({
  payloadType: Schema.String,
  /** The statement's JSON serialization, standard base64. */
  payload: Schema.String,
  signatures: Schema.Array(DsseSignature),
});
export type DsseEnvelope = typeof DsseEnvelope.Type;

/** A public ES256 JWK with its `kid`. */
export const ProvenancePublicJwk = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.NonEmptyString,
  y: Schema.NonEmptyString,
  kid: Schema.NonEmptyString,
});
/** The active provenance key: a private ES256 JWK with its `kid`. */
export const ProvenanceKey = Schema.Struct({ ...ProvenancePublicJwk.fields, d: Schema.NonEmptyString });
export type ProvenanceKey = typeof ProvenanceKey.Type;

export class ProvenanceKeyInvalid extends Schema.TaggedError<ProvenanceKeyInvalid>()(
  "ProvenanceKeyInvalid",
  { kid: Schema.String, message: Schema.String },
) {}

export class EnvelopeMalformed extends Schema.TaggedError<EnvelopeMalformed>()("EnvelopeMalformed", {
  message: Schema.String,
}) {}

const decodeKey = Schema.decodeUnknownOption(Schema.fromJsonString(ProvenanceKey));

/**
 * The active provenance key the `PROVENANCE_KEY` secret holds, or `undefined` while the secret is unset or holds no
 * private P-256 JWK with a `kid`.
 */
export const parseProvenanceKey = (secret: string | undefined): ProvenanceKey | undefined =>
  secret === undefined || secret.trim() === ""
    ? undefined
    : Option.getOrUndefined(decodeKey(secret.trim()));

/** DSSE's pre-authentication encoding of a payload: the bytes every signature in an envelope covers (DSSE v1). */
export const dssePae = (payloadType: string, payload: Uint8Array): Uint8Array => {
  const type = utf8(payloadType);
  const head = utf8(`DSSEv1 ${type.byteLength} ${payloadType} ${payload.byteLength} `);
  const out = new Uint8Array(head.byteLength + payload.byteLength);
  out.set(head);
  out.set(payload, head.byteLength);
  return out;
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

/** The bytes of a standard-base64 string, or `undefined` when it is not one. */
export const fromBase64 = (text: string): Uint8Array | undefined => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return undefined;
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
};

/** An envelope with the given payload bytes and no signature. */
export const unsignedEnvelope = (payload: Uint8Array): DsseEnvelope => ({
  payloadType: DSSE_PAYLOAD_TYPE,
  payload: toBase64(payload),
  signatures: [],
});

/** The pre-authentication encoding of an envelope's payload, or `undefined` when its payload is not base64. */
export const envelopePae = (envelope: DsseEnvelope): Uint8Array | undefined => {
  const payload = fromBase64(envelope.payload);
  return payload === undefined ? undefined : dssePae(envelope.payloadType, payload);
};

/** Signs `pae` with the provenance key, answering the DSSE signature keyed by the key's `kid`. */
export const signPae = async (key: ProvenanceKey, pae: Uint8Array): Promise<DsseSignature> => {
  const signing = await crypto.subtle.importKey("jwk", key, P256, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign(ES256, signing, asBuffer(pae)));
  return { keyid: key.kid, sig: toBase64(sig) };
};

/** Whether `signature` is a valid ES256 signature by `publicJwk` over the envelope's pre-authentication encoding. */
export const verifyDsseSignature = async (
  publicJwk: JsonWebKey,
  envelope: DsseEnvelope,
  signature: DsseSignature,
): Promise<boolean> => {
  const pae = envelopePae(envelope);
  const sig = fromBase64(signature.sig);
  if (pae === undefined || sig === undefined) return false;
  try {
    const { kty, crv, x, y } = publicJwk;
    const key = await crypto.subtle.importKey("jwk", { kty, crv, x, y }, P256, false, ["verify"]);
    return await crypto.subtle.verify(ES256, key, asBuffer(sig), asBuffer(pae));
  } catch {
    return false;
  }
};
