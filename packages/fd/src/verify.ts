// The offline verifier `fd verify` runs (specs/provenance.md § Verification policy, FD-IFC-071). It reads three
// inputs, all local: the policy root key the verifier pinned out of band, a verification policy envelope, and a
// statement bundle; it checks one artifact's digest against them and opens no network connection. It runs the
// procedure in order and stops at the first failure:
//
//   1. the policy verifies against the pinned root key (FD-PROV-053);
//   2. each statement's inclusion proof verifies against a checkpoint signed by a log key in the policy (FD-PROV-054);
//   3. a private-log checkpoint carries a cosignature from a witness the policy names (FD-PROV-055);
//   4. a device builder's key is registered, and the log time falls in [`registered_at`, `compromised_from`)
//      (FD-PROV-057);
//   5. every provenance-key signature, countersignature or cloud-builder signature, has a validity window that holds
//      the log time (FD-PROV-056);
//   6. a subject digest equals the artifact's digest (FD-PROV-058);
//   7. the tier assigned is at least the policy's required tier for the artifact class (FD-PROV-059).
//
// The tier is the highest whose conditions hold: `device-signed` for a device statement bound by a registration, which
// never rises above it (FD-PROV-060); `platform` for a statement bound by an execution lease; `reproduced` for two
// `platform` statements with equal subject digests and no restored cache entry, one of them signed by a provenance key
// as a cloud builder (FD-PROV-061), with a logged reproduction record countersigned over both envelope digests. A
// statement's log time is its log entry's integrated time, never a signer's clock.
import {
  derToP1363,
  dssePae,
  DsseEnvelope,
  DsseSignature,
  fromBase64,
  HASH_SIZE,
  leafHash,
  verifyInclusion,
} from "@fractalboxdev/flare-dispatch-cache";
import { canonicalJson, sha256Hex, utf8 } from "@fractalboxdev/flare-dispatch-cache/crypto";
import {
  decodePolicyEnvelope,
  POLICY_PAYLOAD_TYPE,
  PublicKeyJwk,
  type KeyHistoryEntry,
  type VerificationPolicy,
} from "@fractalboxdev/flare-dispatch-cache/provenance-policy";
import { REPRODUCTION_PAYLOAD_TYPE } from "@fractalboxdev/flare-dispatch-cache/reproduction-request";
import { Effect, Option, Schema } from "effect";

export { REPRODUCTION_PAYLOAD_TYPE };

/** The artifact classes a policy sets a required tier for. */
export const ArtifactClass = Schema.Literals([
  "release",
  "package",
  "image",
  "pr-artifact",
  "preview",
  "verdict",
]);
export type ArtifactClass = typeof ArtifactClass.Type;

export type Tier = "device-signed" | "platform" | "reproduced";
const TIER_RANK: Readonly<Record<Tier, number>> = {
  "device-signed": 1,
  platform: 2,
  reproduced: 3,
};

const NonNegativeInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

/** A statement's log entry with what proves it offline: the inclusion proof and the checkpoint it verifies against. */
export const LogProof = Schema.Struct({
  log: Schema.Literals(["rekor", "private"]),
  /** The leaf index in the tree the checkpoint signs. */
  index: NonNegativeInt,
  /** The log's integrated time, milliseconds since the Unix epoch: the statement's log time. */
  integrated_time: NonNegativeInt,
  /** The RFC 9162 inclusion proof, each hash standard base64. */
  inclusion_proof: Schema.Array(Schema.String),
  /** The signed checkpoint (C2SP tlog-checkpoint note) with its signature lines, cosignatures included. */
  checkpoint: Schema.String,
  /** Rekor only: the entry body, standard base64, whose canonical bytes are the leaf. */
  body: Schema.optionalKey(Schema.String),
});
export type LogProof = typeof LogProof.Type;

/** One logged statement: the countersigned envelope, the device key for a device builder, and its log proof. */
export const BundledStatement = Schema.Struct({
  envelope: DsseEnvelope,
  device_key: Schema.optionalKey(PublicKeyJwk),
  log_entry: LogProof,
});
export type BundledStatement = typeof BundledStatement.Type;

export const ReproductionEnvelope = Schema.Struct({
  payloadType: Schema.Literal(REPRODUCTION_PAYLOAD_TYPE),
  payload: Schema.String,
  signatures: Schema.Array(DsseSignature),
});
export type ReproductionEnvelope = typeof ReproductionEnvelope.Type;

/** What `fd verify` checks an artifact against: one statement, or two with a reproduction record. */
export const StatementBundle = Schema.Struct({
  statements: Schema.Array(BundledStatement),
  reproduction_record: Schema.optionalKey(
    Schema.Struct({ envelope: ReproductionEnvelope, log_entry: LogProof }),
  ),
});
export type StatementBundle = typeof StatementBundle.Type;

const ReproductionRecord = Schema.Struct({
  envelope_digests: Schema.Array(Schema.String),
});

/** Why the verifier rejects an artifact. */
export const VerifyRejection = Schema.Literals([
  "policy-signature",
  "malformed",
  "inclusion-proof",
  "witness-cosignature",
  "device-key",
  "device-window",
  "countersignature",
  "key-window",
  "subject-digest",
  "tier",
]);
export type VerifyRejection = typeof VerifyRejection.Type;

export class VerifyRejected extends Schema.TaggedError<VerifyRejected>()("VerifyRejected", {
  reason: VerifyRejection,
  message: Schema.String,
}) {}

/** The artifact passes, at `tier`. */
export interface VerifyPass {
  readonly policy_version: string;
  readonly artifact_digest: string;
  readonly artifact_class: ArtifactClass;
  readonly tier: Tier;
  readonly required_tier: Tier;
  readonly statements: ReadonlyArray<{
    readonly envelope_digest: string;
    readonly builder: "device" | "cloud";
    readonly tier: Tier | null;
    readonly log: "rekor" | "private";
    readonly integrated_time: number;
  }>;
}

export interface VerifyInput {
  /** The policy root key the verifier pinned, a public ES256 JWK. */
  readonly rootKey: JsonWebKey;
  /** The verification policy envelope, parsed JSON. */
  readonly policy: unknown;
  /** The statement bundle, parsed JSON. */
  readonly bundle: unknown;
  /** The artifact's digest, `sha256:<hex>`. */
  readonly artifactDigest: string;
  readonly artifactClass: ArtifactClass;
}

const reject = (reason: VerifyRejection, message: string) =>
  Effect.fail(new VerifyRejected({ reason, message }));

// ---------------------------------------------------------------------------------------------------------------------
// Signatures

const ES256 = { name: "ECDSA", hash: "SHA-256" } as const;
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

const buffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const importEs256 = (jwk: JsonWebKey) =>
  crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, P256, true, [
    "verify",
  ]);

/** Whether `sig`, IEEE P1363, is a valid ES256 signature by `jwk` over `bytes`. */
const verifyP1363 = async (
  jwk: JsonWebKey,
  bytes: Uint8Array,
  sig: Uint8Array,
): Promise<boolean> => {
  try {
    return await crypto.subtle.verify(ES256, await importEs256(jwk), buffer(sig), buffer(bytes));
  } catch {
    return false;
  }
};

/** Whether `sig`, standard-base64 ASN.1 DER, is a valid ES256 signature by `jwk` over `bytes`. */
const verifyDer = async (jwk: JsonWebKey, bytes: Uint8Array, sig: string): Promise<boolean> => {
  const der = fromBase64(sig);
  const p1363 = der === undefined ? undefined : derToP1363(der);
  return p1363 !== undefined && verifyP1363(jwk, bytes, p1363);
};

const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(bytes)));

const toBase64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** The RFC 7638 thumbprint of a public P-256 JWK: base64url SHA-256 of its required members in lexical order. */
export const jwkThumbprint = async (jwk: PublicKeyJwk): Promise<string> =>
  toBase64url(
    await sha256(utf8(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`)),
  );

/** Whether a key-history entry's window, [`not_before`, `not_after`), holds `time`. */
const inWindow = (entry: KeyHistoryEntry, time: number): boolean =>
  entry.not_before <= time && (entry.not_after === undefined || time < entry.not_after);

// ---------------------------------------------------------------------------------------------------------------------
// Checkpoints

interface Note {
  readonly body: string;
  readonly size: number;
  readonly root: Uint8Array;
  readonly signatures: ReadonlyArray<{ readonly name: string; readonly sig: Uint8Array }>;
}

/**
 * A C2SP signed note carrying a tlog-checkpoint: the body (origin, tree size, base64 root hash, then any extension
 * lines), a blank line, and signature lines `— <name> <base64>`. `undefined` when the text is not one.
 */
export const parseNote = (text: string): Note | undefined => {
  const split = text.indexOf("\n\n");
  if (split < 0) return undefined;
  const body = text.slice(0, split + 1);
  const [, size, root] = body.split("\n");
  const rootBytes = root === undefined ? undefined : fromBase64(root);
  if (size === undefined || !/^(0|[1-9][0-9]*)$/.test(size) || rootBytes?.byteLength !== HASH_SIZE)
    return undefined;
  const signatures: { name: string; sig: Uint8Array }[] = [];
  for (const line of text.slice(split + 2).split("\n")) {
    if (line === "") continue;
    const m = /^— (\S+) (\S+)$/.exec(line);
    const sig = m === null ? undefined : fromBase64(m[2]!);
    if (m === null || sig === undefined) return undefined;
    signatures.push({ name: m[1]!, sig });
  }
  return { body, size: Number(size), root: rootBytes, signatures };
};

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);

/** The first 4 bytes of SHA-256 of a P-256 key's SubjectPublicKeyInfo: the key hint a Rekor checkpoint signature leads with. */
const rekorKeyHint = async (jwk: JsonWebKey): Promise<Uint8Array> => {
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey("spki", await importEs256(jwk))) as ArrayBuffer,
  );
  return (await sha256(spki)).subarray(0, 4);
};

/**
 * Whether a log key of the policy signs the checkpoint. A private-log signature line names the log key's `kid` and
 * carries its IEEE P1363 signature over the body (specs/provenance.md § Private log); a Rekor signature carries the
 * 4-byte key hint of the log key, then its ASN.1 DER signature.
 */
const signedByLogKey = async (
  note: Note,
  log: "rekor" | "private",
  keys: readonly KeyHistoryEntry[],
): Promise<boolean> => {
  const body = utf8(note.body);
  for (const key of keys)
    for (const line of note.signatures) {
      if (log === "private") {
        if (line.name === key.kid && (await verifyP1363(key.jwk, body, line.sig))) return true;
        continue;
      }
      if (
        line.sig.byteLength <= 4 ||
        !equalBytes(line.sig.subarray(0, 4), await rekorKeyHint(key.jwk))
      )
        continue;
      const p1363 = derToP1363(line.sig.subarray(4));
      if (p1363 !== undefined && (await verifyP1363(key.jwk, body, p1363))) return true;
    }
  return false;
};

/** The C2SP tlog-cosignature algorithm byte of an Ed25519 cosignature/v1 key. */
const COSIGNATURE_V1 = 0x04;

/**
 * Whether the checkpoint carries a valid C2SP tlog-cosignature by the witness whose note verifier key is `vkey`
 * (`<name>+<key id hex>+<base64(0x04 ‖ Ed25519 public key)>`): a signature line under the witness's name holding the
 * key id, an 8-byte big-endian timestamp and the Ed25519 signature over `cosignature/v1\ntime <t>\n<body>`.
 */
export const cosignedBy = async (note: Note, vkey: string): Promise<boolean> => {
  const m = /^([^+\s]+)\+([0-9a-f]{8})\+(\S+)$/.exec(vkey);
  const key = m === null ? undefined : fromBase64(m[3]!);
  if (m === null || key === undefined || key.byteLength !== 33 || key[0] !== COSIGNATURE_V1)
    return false;
  const name = m[1]!;
  const keyId = (await sha256(new Uint8Array([...utf8(`${name}\n`), ...key]))).subarray(0, 4);
  if (Array.from(keyId, (b) => b.toString(16).padStart(2, "0")).join("") !== m[2]) return false;
  let publicKey: CryptoKey;
  try {
    publicKey = await crypto.subtle.importKey(
      "raw",
      buffer(key.subarray(1)),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    return false;
  }
  for (const line of note.signatures) {
    if (line.name !== name || line.sig.byteLength !== 4 + 8 + 64) continue;
    if (!equalBytes(line.sig.subarray(0, 4), keyId)) continue;
    const time = new DataView(buffer(line.sig.subarray(4, 12))).getBigUint64(0);
    const message = utf8(`cosignature/v1\ntime ${time}\n${note.body}`);
    try {
      if (
        await crypto.subtle.verify(
          { name: "Ed25519" },
          publicKey,
          buffer(line.sig.subarray(12)),
          buffer(message),
        )
      )
        return true;
    } catch {
      // A signature that does not verify is no cosignature.
    }
  }
  return false;
};

// ---------------------------------------------------------------------------------------------------------------------
// Log proofs

interface AnyEnvelope {
  readonly payloadType: string;
  readonly payload: string;
  readonly signatures: readonly DsseSignature[];
}

const RekorDsseBody = Schema.Struct({
  kind: Schema.Literal("dsse"),
  spec: Schema.Struct({
    payloadHash: Schema.Struct({ algorithm: Schema.Literal("sha256"), value: Schema.String }),
    signatures: Schema.Array(Schema.Struct({ signature: Schema.String })),
  }),
});
const decodeRekorBody = Schema.decodeUnknownOption(Schema.fromJsonString(RekorDsseBody));

/** Whether two lists hold the same strings, each as many times. */
const sameMultiset = (a: readonly string[], b: readonly string[]): boolean => {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((x, i) => x === right[i]);
};

/**
 * The leaf bytes that log `proof.log` holds for `envelope`: the private log appends the envelope's canonical JSON;
 * Rekor's leaf is the entry body, which must name the envelope's payload hash and exactly its signatures, no more and
 * no fewer. A logged body with a signature the envelope lacks proves a different envelope: an envelope with its device
 * signature stripped is not the one the log holds.
 */
const leafOf = async (envelope: AnyEnvelope, proof: LogProof): Promise<Uint8Array | undefined> => {
  if (proof.log === "private") return utf8(canonicalJson(envelope));
  const body = proof.body === undefined ? undefined : fromBase64(proof.body);
  const payload = fromBase64(envelope.payload);
  if (body === undefined || payload === undefined) return undefined;
  const entry = Option.getOrUndefined(decodeRekorBody(new TextDecoder().decode(body)));
  if (entry === undefined || entry.spec.payloadHash.value !== (await sha256Hex(payload)))
    return undefined;
  return sameMultiset(
    entry.spec.signatures.map((s) => s.signature),
    envelope.signatures.map((s) => s.sig),
  )
    ? body
    : undefined;
};

/**
 * Checks that `envelope` is in its log: the inclusion proof verifies against a checkpoint a policy log key signs
 * (FD-PROV-054), and a private-log checkpoint carries a cosignature by a witness the policy names (FD-PROV-055).
 */
const checkLogged = (
  policy: VerificationPolicy,
  what: string,
  envelope: AnyEnvelope,
  proof: LogProof,
) =>
  Effect.gen(function* () {
    const logs = policy.logs.filter((l) => l.kind === proof.log);
    const note = parseNote(proof.checkpoint);
    if (note === undefined)
      return yield* reject(
        "inclusion-proof",
        `${what}: the checkpoint is not a signed tlog checkpoint`,
      );
    const keys = logs.flatMap((l) => l.keys);
    if (!(yield* Effect.promise(() => signedByLogKey(note, proof.log, keys))))
      return yield* reject(
        "inclusion-proof",
        `${what}: no ${proof.log} log key in policy ${policy.policy_version} signs the checkpoint`,
      );
    const leaf = yield* Effect.promise(() => leafOf(envelope, proof));
    const path = proof.inclusion_proof.map(fromBase64);
    const hashes = path.every((h): h is Uint8Array => h?.byteLength === HASH_SIZE)
      ? path
      : undefined;
    const included =
      leaf !== undefined &&
      hashes !== undefined &&
      (yield* Effect.promise(async () =>
        verifyInclusion(proof.index, note.size, await leafHash(leaf), hashes, note.root),
      ));
    if (!included)
      return yield* reject(
        "inclusion-proof",
        `${what}: the inclusion proof of leaf ${proof.index} does not verify against the checkpoint of size ${note.size}`,
      );
    if (proof.log === "private") {
      const witnesses = logs.flatMap((l) => l.witnesses ?? []);
      let cosigned = false;
      for (const w of witnesses)
        if (!cosigned) cosigned = yield* Effect.promise(() => cosignedBy(note, w.key));
      if (!cosigned)
        return yield* reject(
          "witness-cosignature",
          witnesses.length === 0
            ? `${what}: policy ${policy.policy_version} names no witness for the private log`
            : `${what}: the private-log checkpoint carries no cosignature by ${witnesses.map((w) => w.name).join(", ")}`,
        );
    }
  });

/** A signature on an envelope that verifies under the provenance key its `keyid` names. */
interface ProvenanceSigned {
  readonly signature: DsseSignature;
  readonly key: KeyHistoryEntry;
}

/** The signatures on `envelope` that verify under the provenance key their `keyid` names, whatever its window. */
const provenanceSigned = async (
  policy: VerificationPolicy,
  envelope: AnyEnvelope,
): Promise<ProvenanceSigned[]> => {
  const payload = fromBase64(envelope.payload);
  if (payload === undefined) return [];
  const pae = dssePae(envelope.payloadType, payload);
  const keys = new Map(policy.provenance_keys.map((k) => [k.kid, k]));
  const verified: ProvenanceSigned[] = [];
  for (const signature of envelope.signatures) {
    const key = keys.get(signature.keyid);
    if (key !== undefined && (await verifyDer(key.jwk, pae, signature.sig)))
      verified.push({ signature, key });
  }
  return verified;
};

/**
 * Checks each verified provenance-key signature against the log time: a key whose window excludes it rejects the
 * statement (FD-PROV-056). No verified signature rejects it too: a device statement needs the countersignature, a cloud
 * statement its cloud-builder signature.
 */
const checkKeyWindows = (
  policy: VerificationPolicy,
  what: string,
  verified: readonly ProvenanceSigned[],
  time: number,
) =>
  Effect.gen(function* () {
    for (const { key } of verified)
      if (!inWindow(key, time))
        return yield* reject(
          "key-window",
          `${what}: provenance key ${key.kid} is valid from ${key.not_before}${
            key.not_after === undefined ? "" : ` to ${key.not_after}`
          }, and the log time is ${time}`,
        );
    if (verified.length === 0)
      return yield* reject(
        "countersignature",
        `${what}: no signature by a provenance key of policy ${policy.policy_version} verifies`,
      );
  });

/** The provenance-key signatures on `envelope` that verify, each checked against the log time (FD-PROV-056). */
const checkProvenanceSignatures = (
  policy: VerificationPolicy,
  what: string,
  envelope: AnyEnvelope,
  time: number,
) =>
  Effect.promise(() => provenanceSigned(policy, envelope)).pipe(
    Effect.tap((verified) => checkKeyWindows(policy, what, verified, time)),
  );

// ---------------------------------------------------------------------------------------------------------------------
// Statements

const Descriptor = Schema.Struct({
  name: Schema.optional(Schema.String),
  digest: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  annotations: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
type Descriptor = typeof Descriptor.Type;
const LeaseClaim = Schema.Struct({
  binding_kind: Schema.Literals(["execution-lease", "registration"]),
});
const decodeLease = Schema.decodeUnknownOption(LeaseClaim);
const decodeClaims = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      _type: Schema.Literal("https://in-toto.io/Statement/v1"),
      subject: Schema.Array(Descriptor),
      predicateType: Schema.String,
      predicate: Schema.Struct({
        buildDefinition: Schema.optional(
          Schema.Struct({
            internalParameters: Schema.Struct({ lease: Schema.Unknown }),
            resolvedDependencies: Schema.Array(Descriptor),
          }),
        ),
        configuration: Schema.optional(Schema.Array(Descriptor)),
        runDetails: Schema.optional(
          Schema.Struct({ builder: Schema.Struct({ id: Schema.String }) }),
        ),
      }),
    }),
  ),
);

interface Claims {
  readonly bindingKind: "execution-lease" | "registration";
  /** Each subject's SHA-256 digest, lowercase hex. */
  readonly subjects: readonly string[];
  readonly restoredCache: number;
  /** The executor kind the builder id `<executor kind>:<executor_id>` names, when the statement names a builder. */
  readonly builderKind: string | undefined;
}

/** What the verifier reads from a statement: its lease binding, subject digests, restored cache entries and builder. */
const claimsOf = (envelope: DsseEnvelope): Claims | undefined => {
  const payload = fromBase64(envelope.payload);
  const statement =
    payload === undefined
      ? undefined
      : Option.getOrUndefined(decodeClaims(new TextDecoder().decode(payload)));
  if (statement === undefined) return undefined;
  const build = statement.predicate.buildDefinition;
  const configuration = statement.predicate.configuration;
  const leaseRaw =
    build !== undefined
      ? build.internalParameters.lease
      : configuration?.find((d) => d.name === "lease")?.annotations;
  const lease = Option.getOrUndefined(decodeLease(leaseRaw));
  const inputs = build?.resolvedDependencies ?? configuration ?? [];
  const builderAnnotation = configuration?.find((d) => d.name === "builder")?.annotations?.["id"];
  const builderId =
    statement.predicate.runDetails?.builder.id ??
    (typeof builderAnnotation === "string" ? builderAnnotation : undefined);
  if (lease === undefined) return undefined;
  return {
    bindingKind: lease.binding_kind,
    subjects: statement.subject.flatMap((s) =>
      s.digest?.["sha256"] === undefined ? [] : [s.digest["sha256"]],
    ),
    restoredCache: inputs.filter((d: Descriptor) => d.name?.startsWith("cache:") === true).length,
    builderKind: builderId?.split(":")[0],
  };
};

/** The executor kind of a device, as a builder id `<executor kind>:<executor_id>` names it. */
const DEVICE_EXECUTOR_KIND = "device";

interface CheckedStatement {
  readonly envelopeDigest: string;
  readonly builder: "device" | "cloud";
  readonly claims: Claims;
  readonly tier: Tier | null;
  readonly proof: LogProof;
}

/**
 * The tier one statement's conditions reach: `device-signed` for a device statement bound by a registration, and no
 * higher (FD-PROV-060); `platform` for a statement bound by an execution lease; none for a cloud statement bound by a
 * registration, which only a device writes.
 */
const statementTier = (builder: "device" | "cloud", claims: Claims): Tier | null =>
  claims.bindingKind === "registration"
    ? builder === "device"
      ? "device-signed"
      : null
    : "platform";

/** Runs the per-statement steps of the procedure: log, witness, device window, key windows, subject digest. */
const checkStatement = (
  policy: VerificationPolicy,
  position: number,
  bundled: BundledStatement,
  artifactHex: string,
) =>
  Effect.gen(function* () {
    const what = `statement ${position + 1}`;
    const envelope = bundled.envelope;
    const time = bundled.log_entry.integrated_time;
    const claims = claimsOf(envelope);
    if (claims === undefined)
      return yield* reject(
        "malformed",
        `${what}: the payload is not an in-toto statement with a lease binding`,
      );
    yield* checkLogged(policy, what, envelope, bundled.log_entry);
    const payload = fromBase64(envelope.payload)!;
    const pae = dssePae(envelope.payloadType, payload);
    // A cloud-builder statement is one every signature of which verifies under a provenance key, and whose signed
    // builder id names no device: a device statement with its device signature stripped keeps only the
    // countersignature, and its payload still names the device that built it.
    const provenance = yield* Effect.promise(() => provenanceSigned(policy, envelope));
    const byProvenance = new Set(provenance.map((p) => p.signature));
    const cloud =
      claims.builderKind !== DEVICE_EXECUTOR_KIND &&
      envelope.signatures.length > 0 &&
      envelope.signatures.every((s) => byProvenance.has(s));
    if (!cloud) {
      const key = bundled.device_key;
      if (key === undefined)
        return yield* reject(
          "device-key",
          `${what}: a device statement needs its device key in the bundle`,
        );
      const thumbprint = yield* Effect.promise(() => jwkThumbprint(key));
      const device = policy.devices.find((d) => d.key_thumbprint === thumbprint);
      if (device === undefined)
        return yield* reject(
          "device-key",
          `${what}: device key ${thumbprint} is not in the device registry of policy ${policy.policy_version}`,
        );
      let signed = false;
      for (const s of envelope.signatures)
        if (!signed && !byProvenance.has(s))
          signed = yield* Effect.promise(() => verifyDer(key, pae, s.sig));
      if (!signed)
        return yield* reject(
          "device-key",
          `${what}: no device signature by ${thumbprint} verifies over the payload`,
        );
      if (
        time < device.registered_at ||
        (device.compromised_from !== null && time >= device.compromised_from)
      )
        return yield* reject(
          "device-window",
          `${what}: the log time ${time} falls outside device ${device.executor_id}'s window from registered_at ${device.registered_at}${
            device.compromised_from === null
              ? ""
              : ` to compromised_from ${device.compromised_from}`
          }`,
        );
    }
    yield* checkKeyWindows(policy, what, provenance, time);
    if (!claims.subjects.includes(artifactHex))
      return yield* reject(
        "subject-digest",
        `${what}: no subject digest equals the artifact's sha256:${artifactHex}`,
      );
    const builder = cloud ? ("cloud" as const) : ("device" as const);
    const envelopeDigest = `sha256:${yield* Effect.promise(() => sha256Hex(canonicalJson(envelope)))}`;
    return {
      envelopeDigest,
      builder,
      claims,
      tier: statementTier(builder, claims),
      proof: bundled.log_entry,
    } satisfies CheckedStatement;
  });

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((x) => right.has(x));
};

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(ReproductionRecord));

/**
 * Why the bundle does not reach `reproduced`, or `undefined` when it does: two `platform` statements with equal
 * subject digests and no restored cache entry, one from a cloud builder (FD-PROV-061), and a logged reproduction
 * record countersigned over both envelope digests at its own log time.
 */
const reproducedGap = (
  policy: VerificationPolicy,
  statements: readonly CheckedStatement[],
  record: StatementBundle["reproduction_record"],
) =>
  Effect.gen(function* () {
    const [a, b] = statements;
    if (statements.length !== 2 || a === undefined || b === undefined)
      return "reproduced needs two statements";
    if (a.tier !== "platform" || b.tier !== "platform")
      return "reproduced needs two platform statements";
    if (!sameSet(a.claims.subjects, b.claims.subjects))
      return "the two statements' subject digests differ";
    if (a.claims.restoredCache + b.claims.restoredCache > 0)
      return "a statement lists a restored cache entry";
    if (a.builder !== "cloud" && b.builder !== "cloud")
      return "neither statement is signed by a provenance key as a cloud builder";
    if (record === undefined) return "the bundle holds no reproduction record";
    const payload = fromBase64(record.envelope.payload);
    const named =
      payload === undefined
        ? undefined
        : Option.getOrUndefined(decodeRecord(new TextDecoder().decode(payload)));
    if (
      named === undefined ||
      named.envelope_digests.length !== 2 ||
      !sameSet(named.envelope_digests, [a.envelopeDigest, b.envelopeDigest])
    )
      return "the reproduction record does not name both envelope digests";
    return yield* checkLogged(
      policy,
      "reproduction record",
      record.envelope,
      record.log_entry,
    ).pipe(
      Effect.andThen(() =>
        checkProvenanceSignatures(
          policy,
          "reproduction record",
          record.envelope,
          record.log_entry.integrated_time,
        ),
      ),
      Effect.as(undefined),
      Effect.catchTag("VerifyRejected", (e) => Effect.succeed(e.message)),
    );
  });

/** Checks the policy envelope against the pinned root key (FD-PROV-053), answering the policy it carries. */
export const verifyPolicy = (rootKey: JsonWebKey, raw: unknown) =>
  Effect.gen(function* () {
    const decoded = yield* decodePolicyEnvelope(raw).pipe(
      Effect.catchTag("PolicyRefused", (e) =>
        reject(
          "policy-signature",
          `the policy is not a verification policy envelope: ${e.message}`,
        ),
      ),
    );
    const pae = dssePae(POLICY_PAYLOAD_TYPE, fromBase64(decoded.envelope.payload)!);
    let signed = false;
    for (const s of decoded.envelope.signatures)
      if (!signed) signed = yield* Effect.promise(() => verifyDer(rootKey, pae, s.sig));
    if (!signed)
      return yield* reject(
        "policy-signature",
        `policy ${decoded.policy.policy_version} does not verify against the pinned policy root key`,
      );
    return decoded.policy;
  });

const decodeBundle = Schema.decodeUnknownOption(StatementBundle);

/** The verifier procedure of specs/provenance.md § Verification policy, offline. */
export const verifyArtifact = (input: VerifyInput): Effect.Effect<VerifyPass, VerifyRejected> =>
  Effect.gen(function* () {
    const policy = yield* verifyPolicy(input.rootKey, input.policy);
    const bundle = Option.getOrUndefined(decodeBundle(input.bundle));
    if (bundle === undefined || bundle.statements.length < 1 || bundle.statements.length > 2)
      return yield* reject(
        "malformed",
        "the statement bundle holds one or two statements with their log proofs",
      );
    const artifactHex = /^sha256:([0-9a-f]{64})$/.exec(input.artifactDigest)?.[1];
    if (artifactHex === undefined)
      return yield* reject(
        "malformed",
        `the artifact digest ${input.artifactDigest} is not sha256:<hex>`,
      );
    const checked: CheckedStatement[] = [];
    for (const [i, s] of bundle.statements.entries())
      checked.push(yield* checkStatement(policy, i, s, artifactHex));
    const gap = yield* reproducedGap(policy, checked, bundle.reproduction_record);
    const reached = checked.flatMap((s) => (s.tier === null ? [] : [s.tier]));
    const best = reached.reduce<Tier | null>(
      (t, s) => (t === null || TIER_RANK[s] > TIER_RANK[t] ? s : t),
      null,
    );
    const tier: Tier | null = gap === undefined ? "reproduced" : best;
    const required = policy.required_tiers[input.artifactClass];
    if (tier === null || TIER_RANK[tier] < TIER_RANK[required])
      return yield* reject(
        "tier",
        `${input.artifactClass} requires ${required}; the bundle reaches ${tier ?? "no tier"}${
          bundle.statements.length === 2 && gap !== undefined ? ` (not reproduced: ${gap})` : ""
        }`,
      );
    return {
      policy_version: policy.policy_version,
      artifact_digest: input.artifactDigest,
      artifact_class: input.artifactClass,
      tier,
      required_tier: required,
      statements: checked.map((s) => ({
        envelope_digest: s.envelopeDigest,
        builder: s.builder,
        tier: s.tier,
        log: s.proof.log,
        integrated_time: s.proof.integrated_time,
      })),
    };
  });
