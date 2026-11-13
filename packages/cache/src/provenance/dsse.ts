// DSSE envelopes and the provenance key (specs/provenance.md § Keys, § Statement). A statement is an in-toto
// Statement v1 carried as the payload of a DSSE envelope with payload type `application/vnd.in-toto+json`; every
// signature, the device's and the control plane's, is over DSSE's pre-authentication encoding of that payload. The
// control plane signs with the provenance key, an ES256 private JWK with its `kid` held as the `PROVENANCE_KEY` Worker
// secret; a signature's `keyid` is that `kid`, and its `sig` is the standard-base64 ASN.1 DER ECDSA-Sig-Value
// (SEQUENCE of INTEGER r, INTEGER s): the encoding the Secure Enclave's X9.62 signatures carry and Rekor's `dsse`
// verifier reads. WebCrypto signs and verifies IEEE P1363 (r ‖ s), so `signPae` and `verifyDsseSignature` convert.
import { Option, Schema } from "effect";
import { asBuffer, utf8 } from "../crypto.ts";

export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";

const ES256 = { name: "ECDSA", hash: "SHA-256" } as const;
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

export const DsseSignature = Schema.Struct({ keyid: Schema.String, sig: Schema.String });
export type DsseSignature = typeof DsseSignature.Type;

export const DsseEnvelope = Schema.Struct({
  payloadType: Schema.Literal(DSSE_PAYLOAD_TYPE),
  /** The statement's JSON serialization, standard base64. */
  payload: Schema.String,
  signatures: Schema.Array(DsseSignature),
});
export type DsseEnvelope = typeof DsseEnvelope.Type;

/** A signed DSSE envelope of any payload type: a statement, or a reproduction record. */
export const AnyDsseEnvelope = Schema.Struct({
  payloadType: Schema.String,
  payload: Schema.String,
  signatures: Schema.Array(DsseSignature),
});
export type AnyDsseEnvelope = typeof AnyDsseEnvelope.Type;

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

/**
 * DSSE's pre-authentication encoding of a payload: the bytes every signature in an envelope covers, the device key
 * helper's and the provenance key's (DSSE v1 § Protocol).
 */
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
export const envelopePae = (envelope: AnyDsseEnvelope): Uint8Array | undefined => {
  const payload = fromBase64(envelope.payload);
  return payload === undefined ? undefined : dssePae(envelope.payloadType, payload);
};

/** The width of each of r and s in a P-256 P1363 signature. */
const SCALAR = 32;

/** A DER INTEGER's content bytes for an unsigned big-endian scalar: minimal, with a `0x00` when the top bit is set. */
const derInteger = (scalar: Uint8Array): Uint8Array => {
  let start = 0;
  while (start < scalar.byteLength - 1 && scalar[start] === 0) start++;
  const trimmed = scalar.subarray(start);
  const content = (trimmed[0]! & 0x80) === 0 ? trimmed : Uint8Array.of(0, ...trimmed);
  return Uint8Array.of(0x02, content.byteLength, ...content);
};

/** A P-256 IEEE P1363 signature (r ‖ s) as an ASN.1 DER ECDSA-Sig-Value. */
export const p1363ToDer = (sig: Uint8Array): Uint8Array => {
  if (sig.byteLength !== 2 * SCALAR) throw new Error(`a P-256 P1363 signature is 64 bytes, got ${sig.byteLength}`);
  const r = derInteger(sig.subarray(0, SCALAR));
  const s = derInteger(sig.subarray(SCALAR));
  return Uint8Array.of(0x30, r.byteLength + s.byteLength, ...r, ...s);
};

/**
 * A P-256 ASN.1 DER ECDSA-Sig-Value as IEEE P1363 (r ‖ s), or `undefined` when the bytes are not a strict DER encoding
 * of two positive integers of at most 32 bytes each.
 */
export const derToP1363 = (der: Uint8Array): Uint8Array | undefined => {
  if (der.byteLength < 2 || der[0] !== 0x30 || der[1]! >= 0x80 || der[1] !== der.byteLength - 2)
    return undefined;
  const out = new Uint8Array(2 * SCALAR);
  let at = 2;
  for (const offset of [0, SCALAR]) {
    if (der[at] !== 0x02) return undefined;
    const length = der[at + 1];
    if (length === undefined || length === 0 || length >= 0x80) return undefined;
    const content = der.subarray(at + 2, at + 2 + length);
    if (content.byteLength !== length) return undefined;
    // Negative, or a leading 0x00 the next byte's top bit does not need.
    if ((content[0]! & 0x80) !== 0) return undefined;
    if (content[0] === 0 && length > 1 && (content[1]! & 0x80) === 0) return undefined;
    const value = content[0] === 0 && length > 1 ? content.subarray(1) : content;
    if (value.byteLength > SCALAR) return undefined;
    out.set(value, offset + SCALAR - value.byteLength);
    at += 2 + length;
  }
  return at === der.byteLength ? out : undefined;
};

/** The ES256 IEEE P1363 (r ‖ s) signature of `bytes` by the provenance key, as WebCrypto produces it. */
export const signP1363 = async (key: ProvenanceKey, bytes: Uint8Array): Promise<Uint8Array> => {
  const signing = await crypto.subtle.importKey("jwk", key, P256, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign(ES256, signing, asBuffer(bytes)));
};

/** Signs `pae` with the provenance key, answering the DSSE signature keyed by the key's `kid`, its `sig` DER. */
export const signPae = async (key: ProvenanceKey, pae: Uint8Array): Promise<DsseSignature> => ({
  keyid: key.kid,
  sig: toBase64(p1363ToDer(await signP1363(key, pae))),
});

/**
 * Whether `signature` is a valid ES256 signature by `publicJwk` over the envelope's pre-authentication encoding, its
 * `sig` DER. A P1363 `sig` does not verify.
 */
export const verifyDsseSignature = async (
  publicJwk: JsonWebKey,
  envelope: AnyDsseEnvelope,
  signature: DsseSignature,
): Promise<boolean> => {
  const pae = envelopePae(envelope);
  const der = fromBase64(signature.sig);
  const sig = der === undefined ? undefined : derToP1363(der);
  if (pae === undefined || sig === undefined) return false;
  try {
    const { kty, crv, x, y } = publicJwk;
    const key = await crypto.subtle.importKey("jwk", { kty, crv, x, y }, P256, false, ["verify"]);
    return await crypto.subtle.verify(ES256, key, asBuffer(sig), asBuffer(pae));
  } catch {
    return false;
  }
};
