// Test support for the offline verifier: a policy root key, a verification policy, provenance and log keys with their
// windows, a registered device key, a private-log witness, and statements written, signed, countersigned and logged by
// the control plane's own provenance code (statement builder, countersignature, RFC 9162 tree and checkpoint
// signing), so a bundle the verifier accepts is one the control plane produces.
import {
  countersign,
  dssePae,
  DSSE_PAYLOAD_TYPE,
  inclusionProof,
  leafHash,
  p1363ToDer,
  signCheckpoint,
  signP1363,
  signPae,
  statementOf,
  storedHashesForAppend,
  treeHead,
  unsignedEnvelope,
  type DsseEnvelope,
  type ProvenanceKey,
  type StatementBody,
} from "@fractalboxdev/flare-dispatch-cache";
import { canonicalJson, sha256Hex, utf8 } from "@fractalboxdev/flare-dispatch-cache/crypto";
import {
  POLICY_PAYLOAD_TYPE,
  type KeyHistoryEntry,
  type PolicyEnvelope,
  type PublicKeyJwk,
  type VerificationPolicy,
} from "@fractalboxdev/flare-dispatch-cache/provenance-policy";
import { Effect } from "effect";
import {
  jwkThumbprint,
  REPRODUCTION_PAYLOAD_TYPE,
  type ArtifactClass,
  type LogProof,
  type ReproductionEnvelope,
  type StatementBundle,
  type VerifyInput,
} from "./verify.ts";

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const buffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** A fresh ES256 key: the private JWK with its `kid`, and the public JWK. */
export const es256Key = async (kid: string) => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const key = { kty: "EC", crv: "P-256", x: priv.x!, y: priv.y!, d: priv.d!, kid } as ProvenanceKey;
  const jwk: PublicKeyJwk = { kty: "EC", crv: "P-256", x: priv.x!, y: priv.y! };
  return { key, jwk };
};

/** A C2SP tlog-cosignature witness: its Ed25519 key and note verifier key. */
export const witnessKey = async (name: string) => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const key = new Uint8Array([0x04, ...raw]);
  const keyId = new Uint8Array(
    await crypto.subtle.digest("SHA-256", buffer(new Uint8Array([...utf8(`${name}\n`), ...key]))),
  ).subarray(0, 4);
  return {
    name,
    vkey: `${name}+${hex(keyId)}+${toBase64(key)}`,
    /** The cosignature line for a checkpoint body, at `time` seconds. */
    cosign: async (body: string, time: number): Promise<string> => {
      const ts = new Uint8Array(8);
      new DataView(ts.buffer).setBigUint64(0, BigInt(time));
      const sig = new Uint8Array(
        await crypto.subtle.sign(
          { name: "Ed25519" },
          pair.privateKey,
          buffer(utf8(`cosignature/v1\ntime ${time}\n${body}`)),
        ),
      );
      return `— ${name} ${toBase64(new Uint8Array([...keyId, ...ts, ...sig]))}`;
    },
  };
};

/** The instant every fixture time counts from, milliseconds since the Unix epoch. */
export const T0 = 1_780_000_000_000;
/** The provenance key rotation instant: `prov-1` is valid in [T0, T1), `prov-2` from T1. */
export const T1 = T0 + 30 * 86_400_000;
const DAY = 86_400_000;

export const ARTIFACT = utf8("the release tarball's bytes");

const digest = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;

/** A statement body with every field the statement builder records. */
export const statementBody = (
  binding: "execution-lease" | "registration",
  executor: { readonly kind: string; readonly id: string },
  restoredCache = 0,
): StatementBody => ({
  lease: {
    execution_id: "exec-1",
    epoch: 1,
    nonce: "0123456789abcdef0123456789abcdef",
    executor_id: executor.id,
    executor_kind: executor.kind,
    run: { name: "release", kind: "build", definition_digest: digest(1), inputs_digest: digest(2) },
    repository: "acme/widget",
    ref: "refs/tags/v1.0.0",
    commit_sha: "a".repeat(40),
    image_digest: digest(3),
    class: "release",
    policy_version: "v1",
    confidentiality: "unclassified",
    binding_kind: binding,
  },
  outcome: "success",
  commands: [{ name: "build", exit_status: 0 }],
  lockfiles: [],
  fetches: [],
  locked_dependencies: [],
  restored_cache: Array.from({ length: restoredCache }, (_, i) => ({
    namespace: "deps",
    key: `k${i}`,
    digest: digest(4),
  })),
  egress_log_digest: digest(5),
  step_log_digest: digest(6),
  models: [],
});

export interface StatementOptions {
  readonly binding?: "execution-lease" | "registration";
  /** The subject's SHA-256, lowercase hex; the fixture artifact's by default. */
  readonly subjectHex?: string;
  readonly restoredCache?: number;
}

export const makeVerifyFixture = async () => {
  const root = await es256Key("policy-root");
  const prov1 = await es256Key("prov-1");
  const prov2 = await es256Key("prov-2");
  const log = await es256Key("log-1");
  const device = await es256Key("device");
  const compromised = await es256Key("device-compromised");
  const witness = await witnessKey("witness.example");
  const deviceThumbprint = await jwkThumbprint(device.jwk);
  const compromisedThumbprint = await jwkThumbprint(compromised.jwk);
  const artifactHex = await sha256Hex(ARTIFACT);

  const provenanceKeys: KeyHistoryEntry[] = [
    { kid: "prov-1", jwk: prov1.jwk, not_before: T0, not_after: T1 },
    { kid: "prov-2", jwk: prov2.jwk, not_before: T1 },
  ];

  /** The policy every test starts from; `override` replaces top-level fields. */
  const policyDoc = (override: Partial<VerificationPolicy> = {}): VerificationPolicy => ({
    policy_version: "v1",
    issued_at: T0,
    provenance_keys: provenanceKeys,
    logs: [
      {
        kind: "private",
        keys: [{ kid: "log-1", jwk: log.jwk, not_before: T0 }],
        witnesses: [{ name: witness.name, key: witness.vkey }],
      },
    ],
    devices: [
      {
        key_thumbprint: deviceThumbprint,
        executor_id: "mac-1",
        posture_tier: "attested-dedicated",
        registered_at: T0 + DAY,
        revoked_at: null,
        compromised_from: null,
      },
      {
        key_thumbprint: compromisedThumbprint,
        executor_id: "mac-2",
        posture_tier: "attested-dedicated",
        registered_at: T0,
        revoked_at: T0 + 20 * DAY,
        compromised_from: T0 + 10 * DAY,
      },
    ],
    required_tiers: {
      release: "reproduced",
      package: "platform",
      image: "platform",
      "pr-artifact": "platform",
      preview: "platform",
      verdict: "device-signed",
    },
    slsa_build_levels: { cloud: 3, "attested-dedicated": 2, "managed-workstation": 1 },
    ...override,
  });

  /** The policy as the operator publishes it: a DSSE envelope signed by `signer`, the policy root key by default. */
  const signPolicy = async (
    doc: VerificationPolicy,
    signer: ProvenanceKey = root.key,
  ): Promise<PolicyEnvelope> => {
    const payload = utf8(JSON.stringify(doc));
    const sig = await signP1363(signer, dssePae(POLICY_PAYLOAD_TYPE, payload));
    return {
      payloadType: POLICY_PAYLOAD_TYPE,
      payload: toBase64(payload),
      signatures: [{ keyid: signer.kid, sig: toBase64(p1363ToDer(sig)) }],
    };
  };

  const subjectOf = (options: StatementOptions) => [
    { name: "widget.tgz", digest: { sha256: options.subjectHex ?? artifactHex } },
  ];

  /**
   * A device statement as the control plane logs it: the statement builder's envelope, signed by the device key
   * through DSSE's pre-authentication encoding, then countersigned by `provenance` (FD-PROV-032).
   */
  const deviceEnvelope = async (
    options: StatementOptions & {
      readonly signer?: ProvenanceKey;
      readonly provenance?: ProvenanceKey;
    } = {},
  ): Promise<DsseEnvelope> => {
    const signer = options.signer ?? { ...device.key, kid: deviceThumbprint };
    const statement = statementOf(
      statementBody(
        options.binding ?? "execution-lease",
        { kind: "device", id: "mac-1" },
        options.restoredCache,
      ),
      subjectOf(options),
      { code_hash: "c0de" },
    );
    const unsigned = unsignedEnvelope(utf8(JSON.stringify(statement)));
    const signed = {
      ...unsigned,
      signatures: [
        await signPae(signer, dssePae(DSSE_PAYLOAD_TYPE, utf8(JSON.stringify(statement)))),
      ],
    };
    return Effect.runPromise(countersign(signed, options.provenance ?? prov1.key));
  };

  /** A cloud-builder statement: signed once, by `provenance`, as the cloud builder (FD-PROV-008). */
  const cloudEnvelope = async (
    options: StatementOptions & { readonly provenance?: ProvenanceKey } = {},
  ): Promise<DsseEnvelope> => {
    const statement = statementOf(
      statementBody(
        options.binding ?? "execution-lease",
        { kind: "cloudflare", id: "cf-1" },
        options.restoredCache,
      ),
      subjectOf(options),
    );
    const payload = utf8(JSON.stringify(statement));
    return {
      ...unsignedEnvelope(payload),
      signatures: [
        await signPae(options.provenance ?? prov1.key, dssePae(DSSE_PAYLOAD_TYPE, payload)),
      ],
    };
  };

  /** The digest the control plane keys an envelope's log append by: SHA-256 of its canonical JSON. */
  const envelopeDigest = async (envelope: object) =>
    `sha256:${await sha256Hex(canonicalJson(envelope))}`;

  /** A reproduction record naming `digests`, countersigned by `provenance`. */
  const reproductionRecord = async (
    digests: readonly string[],
    provenance: ProvenanceKey = prov1.key,
  ): Promise<ReproductionEnvelope> => {
    const payload = utf8(JSON.stringify({ envelope_digests: digests }));
    return {
      payloadType: REPRODUCTION_PAYLOAD_TYPE,
      payload: toBase64(payload),
      signatures: [await signPae(provenance, dssePae(REPRODUCTION_PAYLOAD_TYPE, payload))],
    };
  };

  /**
   * Appends `envelopes` to a private log, in order, as the `TransparencyLog` object does (each leaf the envelope's
   * canonical JSON), signs the checkpoint with `logKey`, adds the witness's cosignature unless `cosign` is false, and
   * answers each envelope's log proof at `time`.
   */
  const privateLog = async (
    envelopes: readonly object[],
    options: {
      readonly time?: number;
      readonly cosign?: boolean;
      readonly logKey?: ProvenanceKey;
    } = {},
  ): Promise<LogProof[]> => {
    const stored = new Map<string, Uint8Array>();
    const read = (level: number, index: number) => stored.get(`${level}/${index}`)!;
    for (const [i, envelope] of envelopes.entries()) {
      const added = await storedHashesForAppend(
        i,
        await leafHash(utf8(canonicalJson(envelope))),
        read,
      );
      for (const h of added) stored.set(`${h.level}/${h.index}`, h.hash);
    }
    const size = envelopes.length;
    const signed = await signCheckpoint(
      { origin: "plane-1/private-log", size, root: await treeHead(size, read) },
      options.logKey ?? log.key,
    );
    const body = signed.slice(0, signed.indexOf("\n\n") + 1);
    const checkpoint =
      options.cosign === false
        ? signed
        : `${signed}${await witness.cosign(body, Math.floor((options.time ?? T0 + 2 * DAY) / 1000))}\n`;
    return Promise.all(
      envelopes.map(async (_, index) => ({
        log: "private" as const,
        index,
        integrated_time: options.time ?? T0 + 2 * DAY,
        inclusion_proof: (await inclusionProof(index, size, read)).map(toBase64),
        checkpoint,
      })),
    );
  };

  /** One logged statement in a bundle, with the device key when a device signed it. */
  const bundleOf = async (
    envelope: DsseEnvelope,
    options: {
      readonly time?: number;
      readonly cosign?: boolean;
      readonly deviceKey?: PublicKeyJwk | null;
    } = {},
  ): Promise<StatementBundle> => {
    const [proof] = await privateLog([envelope], options);
    const deviceKey = options.deviceKey === undefined ? device.jwk : options.deviceKey;
    return {
      statements: [
        { envelope, log_entry: proof!, ...(deviceKey === null ? {} : { device_key: deviceKey }) },
      ],
    };
  };

  /** A reproduced bundle: a cloud and a device statement and the record over both, all logged at `time`. */
  const reproducedBundle = async (
    options: {
      readonly cloud?: DsseEnvelope;
      readonly device?: DsseEnvelope;
      readonly record?: (digests: readonly string[]) => Promise<ReproductionEnvelope>;
      readonly time?: number;
    } = {},
  ): Promise<StatementBundle> => {
    const cloud = options.cloud ?? (await cloudEnvelope());
    const dev = options.device ?? (await deviceEnvelope());
    const digests = [await envelopeDigest(cloud), await envelopeDigest(dev)];
    const record = await (options.record ?? ((d) => reproductionRecord(d)))(digests);
    const [a, b, r] = await privateLog([cloud, dev, record], { time: options.time });
    return {
      statements: [
        { envelope: cloud, log_entry: a! },
        { envelope: dev, log_entry: b!, device_key: device.jwk },
      ],
      reproduction_record: { envelope: record, log_entry: r! },
    };
  };

  /** The verifier's input: the pinned root key, the signed policy, the bundle and the artifact. */
  const input = async (
    bundle: StatementBundle,
    options: {
      readonly policy?: PolicyEnvelope;
      readonly artifactClass?: ArtifactClass;
      readonly artifactDigest?: string;
    } = {},
  ): Promise<VerifyInput> => ({
    rootKey: root.jwk,
    policy: options.policy ?? (await signPolicy(policyDoc())),
    bundle,
    artifactDigest: options.artifactDigest ?? `sha256:${artifactHex}`,
    artifactClass: options.artifactClass ?? "package",
  });

  return {
    root,
    prov1,
    prov2,
    log,
    device,
    compromised,
    compromisedThumbprint,
    witness,
    artifactHex,
    policyDoc,
    signPolicy,
    deviceEnvelope,
    cloudEnvelope,
    envelopeDigest,
    reproductionRecord,
    privateLog,
    bundleOf,
    reproducedBundle,
    input,
  };
};

export type VerifyFixture = Awaited<ReturnType<typeof makeVerifyFixture>>;
export { DAY };
