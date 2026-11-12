// FlareDispatch's attestation verifier (specs/provenance.md § Enrollment and attestation). mameko's `registerDevice`
// calls it with a device key and the evidence the key helper's `identity` answered, where the profile's
// `registration.attestation` is `verifier` (MAMEKO-LEASE-091). It answers `true` only for a Managed Device Attestation
// whose certificate chain reaches a trusted root, the Apple Enterprise Attestation Root CA in a deployed control plane,
// whose leaf attests that same key, reports SIP enabled and full Secure Boot, and binds the key helper's code-signing
// requirement through its freshness code (FD-PROV-028, FD-PROV-029). The enrollment route records the code-signing
// hash that requirement names as the device's code hash (FD-PROV-031).
import { Effect, Schema } from "effect";

/** The Apple Enterprise Attestation Root CA, from the Apple Private PKI Repository (SHA-256 fingerprint CC:F5:9E:F8…). */
export const APPLE_ENTERPRISE_ATTESTATION_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIICJDCCAamgAwIBAgIUQsDCuyxyfFxeq/bxpm8frF15hzcwCgYIKoZIzj0EAwMw
UTEtMCsGA1UEAwwkQXBwbGUgRW50ZXJwcmlzZSBBdHRlc3RhdGlvbiBSb290IENB
MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzAeFw0yMjAyMTYxOTAx
MjRaFw00NzAyMjAwMDAwMDBaMFExLTArBgNVBAMMJEFwcGxlIEVudGVycHJpc2Ug
QXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UE
BhMCVVMwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAT6Jigq+Ps9Q4CoT8t8q+UnOe2p
oT9nRaUfGhBTbgvqSGXPjVkbYlIWYO+1zPk2Sz9hQ5ozzmLrPmTBgEWRcHjA2/y7
7GEicps9wn2tj+G89l3INNDKETdxSPPIZpPj8VmjQjBAMA8GA1UdEwEB/wQFMAMB
Af8wHQYDVR0OBBYEFPNqTQGd8muBpV5du+UIbVbi+d66MA4GA1UdDwEB/wQEAwIB
BjAKBggqhkjOPQQDAwNpADBmAjEA1xpWmTLSpr1VH4f8Ypk8f3jMUKYz4QPG8mL5
8m9sX/b2+eXpTv2pH4RZgJjucnbcAjEA4ZSB6S45FlPuS/u4pTnzoz632rA+xW/T
ZwFEh9bhKjJ+5VQ9/Do1os0u3LEkgN/r
-----END CERTIFICATE-----`;

/** The Managed Device Attestation leaf extensions the verifier reads. */
export const MDA_OID = {
  /** SHA-256 of the nonce the attestation was requested with, as raw bytes. */
  freshnessCode: "1.2.840.113635.100.8.11.1",
  /** System Integrity Protection: a DER BOOLEAN, `TRUE` when enabled. */
  sipStatus: "1.2.840.113635.100.8.13.1",
  /** The Secure Boot level as text: `full`, `reduced` or `permissive`. */
  secureBoot: "1.2.840.113635.100.8.13.2",
} as const;

/** The `evidence` a Secure Enclave key's `identity` answer carries. */
export const ManagedDeviceAttestationEvidence = Schema.Struct({
  format: Schema.Literal("managed-device-attestation"),
  /** The attestation certificate chain, base64 DER, leaf first; the root may be left out. */
  attestation: Schema.Array(Schema.String),
  /** The value the device requested the attestation with; the control plane does not yet issue it at enrollment. */
  freshness: Schema.String,
  /** The key helper's designated code-signing requirement, naming its `cdhash`. */
  code_signing_requirement: Schema.String,
});
export type ManagedDeviceAttestationEvidence = typeof ManagedDeviceAttestationEvidence.Type;

const isEvidence = Schema.is(ManagedDeviceAttestationEvidence);

const MAX_CHAIN = 4;
const utf8 = new TextEncoder();

const sha256 = (bytes: Uint8Array) =>
  Effect.promise(
    async () => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)),
  );

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

const base64Decode = (text: string): Uint8Array | undefined => {
  try {
    const binary = atob(text.replace(/\s+/g, ""));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
};

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** A certificate's DER, from PEM or from bare base64. */
const certificateBytes = (text: string): Uint8Array | undefined =>
  base64Decode(text.replace(/-----(BEGIN|END) CERTIFICATE-----/g, ""));

/**
 * The key helper's code-signing hash: the one `cdhash H"…"` clause of its designated requirement, lower-case hex of
 * 20 or 32 bytes; `null` for a requirement that names none or more than one.
 */
export const codeSigningHashOfRequirement = (requirement: string): string | null => {
  const clauses = [...requirement.matchAll(/\bcdhash\s+H"([0-9A-Fa-f]*)"/g)];
  if (clauses.length !== 1) return null;
  const hex = clauses[0]![1]!;
  return hex.length === 40 || hex.length === 64 ? hex.toLowerCase() : null;
};

/**
 * The code hash the enrollment route records for a device: the code-signing hash named by the code-signing requirement
 * its attestation evidence carries, and `null` for evidence that carries none, such as a software key's (FD-PROV-031).
 */
export const codeSigningHashOf = (evidence: unknown): string | null =>
  isEvidence(evidence) ? codeSigningHashOfRequirement(evidence.code_signing_requirement) : null;

/**
 * The value whose SHA-256 a leaf's freshness code holds when it binds `freshness` and the code-signing requirement:
 * base64url of SHA-256 over the freshness value, a line feed and the requirement, in UTF-8.
 */
export const attestationNonce = (freshness: string, requirement: string) =>
  Effect.map(sha256(utf8.encode(`${freshness}\n${requirement}`)), base64url);

// --- DER ------------------------------------------------------------------------------------------------------------

interface Der {
  readonly tag: number;
  readonly content: Uint8Array;
  readonly raw: Uint8Array;
}

/** The element at `at`, and where the next one starts; `undefined` for a truncated or high-tag element. */
const readDer = (bytes: Uint8Array, at: number): { node: Der; next: number } | undefined => {
  if (at + 2 > bytes.length) return undefined;
  const tag = bytes[at]!;
  if ((tag & 0x1f) === 0x1f) return undefined;
  let length = bytes[at + 1]!;
  let offset = at + 2;
  if (length & 0x80) {
    const n = length & 0x7f;
    if (n === 0 || n > 4 || offset + n > bytes.length) return undefined;
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + bytes[offset + i]!;
    offset += n;
  }
  const end = offset + length;
  if (end > bytes.length) return undefined;
  return {
    node: { tag, content: bytes.subarray(offset, end), raw: bytes.subarray(at, end) },
    next: end,
  };
};

/** `bytes` as exactly one element. */
const derOne = (bytes: Uint8Array): Der | undefined => {
  const read = readDer(bytes, 0);
  return read !== undefined && read.next === bytes.length ? read.node : undefined;
};

/** The elements of a constructed element's content. */
const derItems = (node: Der): Der[] | undefined => {
  const out: Der[] = [];
  let at = 0;
  while (at < node.content.length) {
    const read = readDer(node.content, at);
    if (read === undefined) return undefined;
    out.push(read.node);
    at = read.next;
  }
  return out;
};

const oidText = (node: Der | undefined): string | undefined => {
  if (node?.tag !== 0x06 || node.content.length === 0) return undefined;
  const first = node.content[0]!;
  const arcs = first < 80 ? [Math.floor(first / 40), first % 40] : [2, first - 80];
  let value = 0;
  for (const byte of node.content.subarray(1)) {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      arcs.push(value);
      value = 0;
    }
  }
  return arcs.join(".");
};

const timeOf = (node: Der | undefined): number | undefined => {
  if (node === undefined) return undefined;
  const text = new TextDecoder().decode(node.content);
  const m =
    node.tag === 0x17
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text)
      : node.tag === 0x18
        ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text)
        : null;
  if (m === null) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const year = node.tag === 0x17 ? (y >= 50 ? 1900 + y : 2000 + y) : y;
  return Date.UTC(year, mo - 1, d, h, mi, s);
};

// --- X.509 ----------------------------------------------------------------------------------------------------------

interface Certificate {
  readonly raw: Uint8Array;
  readonly tbs: Uint8Array;
  readonly signatureAlgorithm: string;
  readonly signature: Uint8Array;
  readonly issuer: Uint8Array;
  readonly subject: Uint8Array;
  readonly notBefore: number;
  readonly notAfter: number;
  readonly spki: Uint8Array;
  readonly curve: string | undefined;
  readonly extensions: ReadonlyMap<string, Uint8Array>;
  readonly ca: boolean;
}

const BASIC_CONSTRAINTS = "2.5.29.19";
const EC_PUBLIC_KEY = "1.2.840.10045.2.1";
const CURVES: Readonly<Record<string, { readonly name: string; readonly size: number }>> = {
  "1.2.840.10045.3.1.7": { name: "P-256", size: 32 },
  "1.3.132.0.34": { name: "P-384", size: 48 },
};
const HASHES: Readonly<Record<string, string>> = {
  "1.2.840.10045.4.3.2": "SHA-256",
  "1.2.840.10045.4.3.3": "SHA-384",
};

/** A certificate's fields, or `undefined` for DER that is not one X.509 v3 certificate with an EC key. */
const parseCertificate = (raw: Uint8Array): Certificate | undefined => {
  const cert = derOne(raw);
  const parts = cert?.tag === 0x30 ? derItems(cert) : undefined;
  if (parts?.length !== 3) return undefined;
  const [tbs, algorithm, signatureValue] = parts as [Der, Der, Der];
  const fields = tbs.tag === 0x30 ? derItems(tbs) : undefined;
  if (fields === undefined) return undefined;
  let i = fields[0]?.tag === 0xa0 ? 1 : 0;
  i++; // serial number
  const innerAlgorithm = fields[i++];
  const [issuer, validity, subject, spki] = [fields[i++], fields[i++], fields[i++], fields[i++]];
  if (innerAlgorithm === undefined || !equalBytes(innerAlgorithm.raw, algorithm.raw))
    return undefined;
  if (issuer?.tag !== 0x30 || subject?.tag !== 0x30 || spki?.tag !== 0x30 || validity?.tag !== 0x30)
    return undefined;
  const times = derItems(validity);
  const notBefore = timeOf(times?.[0]);
  const notAfter = timeOf(times?.[1]);
  const keyAlgorithm = derItems(spki)?.[0];
  const keyParams = keyAlgorithm?.tag === 0x30 ? derItems(keyAlgorithm) : undefined;
  if (oidText(keyParams?.[0]) !== EC_PUBLIC_KEY) return undefined;
  const signatureAlgorithm = oidText(derItems(algorithm)?.[0]);
  if (
    signatureAlgorithm === undefined ||
    notBefore === undefined ||
    notAfter === undefined ||
    signatureValue.tag !== 0x03 ||
    signatureValue.content[0] !== 0
  )
    return undefined;
  const extensions = new Map<string, Uint8Array>();
  for (const field of fields.slice(i)) {
    if (field.tag !== 0xa3) continue;
    const list = derOne(field.content);
    for (const extension of (list?.tag === 0x30 ? derItems(list) : undefined) ?? []) {
      const items = extension.tag === 0x30 ? derItems(extension) : undefined;
      const id = oidText(items?.[0]);
      const value = items?.[items.length - 1];
      if (id === undefined || value?.tag !== 0x04 || extensions.has(id)) return undefined;
      extensions.set(id, value.content);
    }
  }
  const constraints = extensions.get(BASIC_CONSTRAINTS);
  const constraint = constraints === undefined ? undefined : derOne(constraints);
  const cA = constraint?.tag === 0x30 ? derItems(constraint)?.[0] : undefined;
  return {
    raw,
    tbs: tbs.raw,
    signatureAlgorithm,
    signature: signatureValue.content.subarray(1),
    issuer: issuer.raw,
    subject: subject.raw,
    notBefore,
    notAfter,
    spki: spki.raw,
    curve: oidText(keyParams?.[1]),
    extensions,
    ca: cA?.tag === 0x01 && cA.content.length === 1 && cA.content[0] !== 0,
  };
};

/** A DER `ECDSA-Sig-Value` as the fixed-width `r || s` Web Crypto verifies. */
const rawSignature = (der: Uint8Array, size: number): Uint8Array | undefined => {
  const node = derOne(der);
  const ints = node?.tag === 0x30 ? derItems(node) : undefined;
  if (ints?.length !== 2) return undefined;
  const out = new Uint8Array(size * 2);
  for (const [k, int] of ints.entries()) {
    if (int.tag !== 0x02) return undefined;
    let value = int.content;
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value.length > size) return undefined;
    out.set(value, k * size + size - value.length);
  }
  return out;
};

/** Whether `issuer`'s key signed `subject`. */
const signedBy = (subject: Certificate, issuer: Certificate) =>
  Effect.promise(async () => {
    const curve = issuer.curve === undefined ? undefined : CURVES[issuer.curve];
    const hash = HASHES[subject.signatureAlgorithm];
    const signature = curve === undefined ? undefined : rawSignature(subject.signature, curve.size);
    if (curve === undefined || hash === undefined || signature === undefined) return false;
    try {
      const key = await crypto.subtle.importKey(
        "spki",
        issuer.spki as BufferSource,
        { name: "ECDSA", namedCurve: curve.name },
        false,
        ["verify"],
      );
      return await crypto.subtle.verify(
        { name: "ECDSA", hash },
        key,
        signature as BufferSource,
        subject.tbs as BufferSource,
      );
    } catch {
      return false;
    }
  });

/** An extension value as text: the content of a DER string, or the raw bytes as UTF-8. */
const textOf = (value: Uint8Array): string => {
  const node = derOne(value);
  const bytes = node !== undefined && [0x0c, 0x13, 0x16].includes(node.tag) ? node.content : value;
  return new TextDecoder().decode(bytes);
};

/** SIP is enabled only where the leaf says so: a DER BOOLEAN `TRUE`; absent or anything else reads as disabled. */
const sipEnabled = (value: Uint8Array | undefined): boolean => {
  const node = value === undefined ? undefined : derOne(value);
  return node?.tag === 0x01 && node.content.length === 1 && node.content[0] !== 0;
};

export interface AttestationVerifierOptions {
  /** The trusted roots, PEM or base64 DER; a deployed control plane passes the Apple Enterprise Attestation Root CA. */
  readonly roots: readonly string[];
  /** The clock each certificate's validity is checked against. */
  readonly now?: () => number;
}

/**
 * The attestation verifier `registerDevice` calls (MAMEKO-LEASE-091). It answers `true` only when every check holds:
 * the evidence is Managed Device Attestation evidence; each certificate of its chain is in its validity period and
 * signed by the next, every certificate above the leaf is a CA, and the last is signed by a trusted root under the name
 * it names (FD-PROV-028); the leaf's public key is the registering device key; the leaf reports SIP enabled and a
 * Secure Boot level of `full` (FD-PROV-029); its freshness code is SHA-256 of the `attestationNonce` of the evidence's
 * freshness value and code-signing requirement; and that requirement names one code-signing hash.
 */
export const attestationVerifier = (options: AttestationVerifierOptions) => {
  const roots = options.roots
    .map(certificateBytes)
    .map((bytes) => (bytes === undefined ? undefined : parseCertificate(bytes)))
    .filter((root): root is Certificate => root !== undefined);
  const now = options.now ?? Date.now;
  return (publicKey: string, evidence: unknown): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (!isEvidence(evidence)) return false;
      if (codeSigningHashOfRequirement(evidence.code_signing_requirement) === null) return false;
      const parsed = evidence.attestation.map((text) => {
        const bytes = base64Decode(text);
        return bytes === undefined ? undefined : parseCertificate(bytes);
      });
      if (parsed.some((cert) => cert === undefined)) return false;
      // A chain that carries the root itself ends below it.
      const chain = (parsed as Certificate[]).filter(
        (cert, i) => i === 0 || !roots.some((root) => equalBytes(root.raw, cert.raw)),
      );
      if (chain.length === 0 || chain.length > MAX_CHAIN) return false;
      const at = now();
      for (const [i, cert] of chain.entries()) {
        if (at < cert.notBefore || at > cert.notAfter) return false;
        if (i > 0 && !cert.ca) return false;
        const next = chain[i + 1];
        const issuers =
          next === undefined
            ? roots.filter((root) => equalBytes(root.subject, cert.issuer))
            : equalBytes(next.subject, cert.issuer)
              ? [next]
              : [];
        let signed = false;
        for (const issuer of issuers) {
          if (at < issuer.notBefore || at > issuer.notAfter) continue;
          if (yield* signedBy(cert, issuer)) {
            signed = true;
            break;
          }
        }
        if (!signed) return false;
      }
      const leaf = chain[0]!;
      const key = base64Decode(publicKey);
      if (key === undefined || !equalBytes(leaf.spki, key)) return false;
      if (!sipEnabled(leaf.extensions.get(MDA_OID.sipStatus))) return false;
      const secureBoot = leaf.extensions.get(MDA_OID.secureBoot);
      if (secureBoot === undefined || textOf(secureBoot) !== "full") return false;
      const freshnessCode = leaf.extensions.get(MDA_OID.freshnessCode);
      const nonce = yield* attestationNonce(evidence.freshness, evidence.code_signing_requirement);
      const expected = yield* sha256(utf8.encode(nonce));
      return freshnessCode !== undefined && equalBytes(freshnessCode, expected);
    });
};

/** The verifier a deployed control plane binds: rooted at the Apple Enterprise Attestation Root CA alone. */
export const appleAttestationVerifier = attestationVerifier({
  roots: [APPLE_ENTERPRISE_ATTESTATION_ROOT_CA],
});
