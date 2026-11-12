// A test PKI for the attestation verifier: an attestation root and sub CA of P-384 keys, standing in for Apple's, and
// leaf certificates over a device key carrying the Managed Device Attestation extensions the verifier reads.
import { Effect } from "effect";
import { attestationNonce, MDA_OID, type ManagedDeviceAttestationEvidence } from "./attestation.ts";

const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const tlv = (tag: number, content: Uint8Array): Uint8Array => {
  const n = content.length;
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return concat(Uint8Array.of(tag, ...length), content);
};

const seq = (...parts: readonly Uint8Array[]) => tlv(0x30, concat(...parts));

const oid = (text: string): Uint8Array => {
  const [a, b, ...rest] = text.split(".").map(Number) as [number, number, ...number[]];
  const bytes = [a * 40 + b];
  for (const arc of rest) {
    const groups = [arc & 0x7f];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128))
      groups.unshift((v & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return tlv(0x06, Uint8Array.from(bytes));
};

const integer = (bytes: Uint8Array): Uint8Array => {
  let value = bytes;
  while (value.length > 1 && value[0] === 0 && value[1]! < 0x80) value = value.subarray(1);
  return tlv(0x02, value[0]! >= 0x80 ? concat(Uint8Array.of(0), value) : value);
};

const text = (value: string) => new TextEncoder().encode(value);

/** A DER BOOLEAN. */
export const derBoolean = (value: boolean): Uint8Array =>
  tlv(0x01, Uint8Array.of(value ? 0xff : 0));

const name = (commonName: string) =>
  seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, text(commonName)))));

const generalizedTime = (at: number) =>
  tlv(
    0x18,
    text(
      new Date(at)
        .toISOString()
        .replace(/[-:T]/g, "")
        .replace(/\.\d{3}Z$/, "Z"),
    ),
  );

const CURVE_SIZE = { "P-256": 32, "P-384": 48 } as const;
const SIGNATURE_ALGORITHM = {
  "P-256": "1.2.840.10045.4.3.2",
  "P-384": "1.2.840.10045.4.3.3",
} as const;
const HASH = { "P-256": "SHA-256", "P-384": "SHA-384" } as const;

type Curve = keyof typeof CURVE_SIZE;

export interface Authority {
  readonly name: string;
  readonly curve: Curve;
  readonly keys: CryptoKeyPair;
  /** The authority's own certificate, DER. */
  readonly certificate: Uint8Array;
}

export interface CertificateSpec {
  readonly subject: string;
  readonly publicKey: CryptoKey;
  readonly ca?: boolean;
  readonly notBefore?: number;
  readonly notAfter?: number;
  readonly extensions?: readonly { readonly oid: string; readonly value: Uint8Array }[];
}

const DAY = 86_400_000;

/** An X.509 v3 certificate over `spec.publicKey`, signed by `issuer` (by its own key for a self-signed one). */
export const issueCertificate = async (
  spec: CertificateSpec,
  issuer: { readonly name: string; readonly curve: Curve; readonly privateKey: CryptoKey },
): Promise<Uint8Array> => {
  const algorithm = seq(oid(SIGNATURE_ALGORITHM[issuer.curve]));
  const extensions = [
    ...(spec.ca === true
      ? [seq(oid("2.5.29.19"), derBoolean(true), tlv(0x04, seq(derBoolean(true))))]
      : []),
    ...(spec.extensions ?? []).map((e) => seq(oid(e.oid), tlv(0x04, e.value))),
  ];
  const tbs = seq(
    tlv(0xa0, integer(Uint8Array.of(2))),
    integer(crypto.getRandomValues(new Uint8Array(16))),
    algorithm,
    name(issuer.name),
    seq(
      generalizedTime(spec.notBefore ?? Date.now() - DAY),
      generalizedTime(spec.notAfter ?? Date.now() + 365 * DAY),
    ),
    name(spec.subject),
    new Uint8Array((await crypto.subtle.exportKey("spki", spec.publicKey)) as ArrayBuffer),
    ...(extensions.length === 0 ? [] : [tlv(0xa3, seq(...extensions))]),
  );
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: HASH[issuer.curve] },
      issuer.privateKey,
      tbs as BufferSource,
    ),
  );
  const size = CURVE_SIZE[issuer.curve];
  const signature = seq(integer(raw.subarray(0, size)), integer(raw.subarray(size)));
  return seq(tbs, algorithm, tlv(0x03, concat(Uint8Array.of(0), signature)));
};

const keyPair = (curve: Curve) =>
  crypto.subtle.generateKey({ name: "ECDSA", namedCurve: curve }, true, [
    "sign",
    "verify",
  ]) as Promise<CryptoKeyPair>;

/** A self-signed root CA. */
export const newRoot = async (
  commonName = "Test Enterprise Attestation Root CA",
): Promise<Authority> => {
  const keys = await keyPair("P-384");
  const certificate = await issueCertificate(
    { subject: commonName, publicKey: keys.publicKey, ca: true },
    { name: commonName, curve: "P-384", privateKey: keys.privateKey },
  );
  return { name: commonName, curve: "P-384", keys, certificate };
};

/** A sub CA under `parent`. */
export const newSubCa = async (
  parent: Authority,
  commonName = "Test Enterprise Attestation Sub CA 1",
  ca = true,
): Promise<Authority> => {
  const keys = await keyPair("P-384");
  const certificate = await issueCertificate(
    { subject: commonName, publicKey: keys.publicKey, ca },
    { name: parent.name, curve: parent.curve, privateKey: parent.keys.privateKey },
  );
  return { name: commonName, curve: "P-384", keys, certificate };
};

export const base64 = (bytes: Uint8Array | ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)));

/** PEM of a DER certificate. */
export const pem = (der: Uint8Array): string =>
  `-----BEGIN CERTIFICATE-----\n${base64(der).replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----`;

/** A designated requirement naming the key helper's `cdhash`. */
export const keyHelperRequirement = (cdhash: string) =>
  `identifier "dev.flaredispatch.key-helper" and anchor apple generic and cdhash H"${cdhash}"`;

export interface DeviceAttestation {
  /** The leaf's Secure Boot level; `null` leaves the extension out. */
  readonly secureBoot?: string | null;
  /** The leaf's SIP status value; `null` leaves the extension out. */
  readonly sip?: Uint8Array | null;
  readonly freshness?: string;
  readonly requirement?: string;
  /** The requirement the leaf's freshness code binds, where it differs from the one the evidence carries. */
  readonly boundRequirement?: string;
  readonly notBefore?: number;
  readonly notAfter?: number;
  /** Whether the evidence's chain also carries the root. */
  readonly withRoot?: boolean;
}

/**
 * A Secure Enclave key's `evidence`: a leaf over `devicePublicKey` issued by `subCa`, with the Managed Device
 * Attestation extensions `attestation` names (by default SIP enabled, full Secure Boot, a freshness code binding the
 * requirement), and the chain leaf first.
 */
export const attestedEvidence = async (
  root: Authority,
  subCa: Authority,
  devicePublicKey: CryptoKey,
  attestation: DeviceAttestation = {},
): Promise<ManagedDeviceAttestationEvidence> => {
  const freshness = attestation.freshness ?? base64(crypto.getRandomValues(new Uint8Array(16)));
  const requirement = attestation.requirement ?? keyHelperRequirement("ab".repeat(20));
  const nonce = await Effect.runPromise(
    attestationNonce(freshness, attestation.boundRequirement ?? requirement),
  );
  const freshnessCode = new Uint8Array(
    await crypto.subtle.digest("SHA-256", text(nonce) as BufferSource),
  );
  const sip = attestation.sip === undefined ? derBoolean(true) : attestation.sip;
  const secureBoot = attestation.secureBoot === undefined ? "full" : attestation.secureBoot;
  const leaf = await issueCertificate(
    {
      subject: "device attestation",
      publicKey: devicePublicKey,
      ...(attestation.notBefore === undefined ? {} : { notBefore: attestation.notBefore }),
      ...(attestation.notAfter === undefined ? {} : { notAfter: attestation.notAfter }),
      extensions: [
        { oid: MDA_OID.freshnessCode, value: freshnessCode },
        ...(sip === null ? [] : [{ oid: MDA_OID.sipStatus, value: sip }]),
        ...(secureBoot === null ? [] : [{ oid: MDA_OID.secureBoot, value: text(secureBoot) }]),
      ],
    },
    { name: subCa.name, curve: subCa.curve, privateKey: subCa.keys.privateKey },
  );
  return {
    format: "managed-device-attestation",
    attestation: [
      leaf,
      subCa.certificate,
      ...(attestation.withRoot === true ? [root.certificate] : []),
    ].map(base64),
    freshness,
    code_signing_requirement: requirement,
  };
};

/** A fresh P-256 device key and its base64 DER SubjectPublicKeyInfo. */
export const newDeviceKey = async () => {
  const keys = await keyPair("P-256");
  return {
    keys,
    publicKey: base64((await crypto.subtle.exportKey("spki", keys.publicKey)) as ArrayBuffer),
  };
};
