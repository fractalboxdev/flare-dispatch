// The release publish gate (specs/provenance.md § Releases). Before a release recipe's publish step uploads an
// artifact, the control plane looks up the release execution's logged statements and admits the publish only when,
// for every artifact digest, one of them is a `platform` statement from a cloud builder naming that digest as a
// subject (FD-PROV-062) and none of those statements lists a restored cache entry (FD-PROV-063). Either refusal
// concludes the release `failure` with its `provenance:` reason.
//
// A statement counts as a `platform` statement from a cloud builder when its log append succeeded, its `binding_kind`
// is `execution-lease`, its lease binding names the release execution, and every signature in its envelope verifies
// under a provenance key: the cloud builder's envelope carries the provenance key's signature alone, where a device
// statement also carries the device key's.
import { Effect, Option, Schema } from "effect";
import { LogAppendStatus, LogAppendStore, type LogEntry } from "./append.ts";
import { DsseEnvelope, fromBase64, verifyDsseSignature } from "./dsse.ts";
import { BindingKind, SLSA_PROVENANCE_V1, TEST_RESULT_V0_1 } from "./statement.ts";

/** The reason a release concludes with when no logged cloud-builder statement names an artifact's digest. */
export const RELEASE_STATEMENT_MISSING = "provenance: release statement missing";
/** The reason a release concludes with when its statement lists a restored cache entry. */
export const RELEASE_BUILT_WARM = "provenance: release built warm";

export const ReleaseRefusalReason = Schema.Literals([RELEASE_STATEMENT_MISSING, RELEASE_BUILT_WARM]);
export type ReleaseRefusalReason = typeof ReleaseRefusalReason.Type;

/** The publish refused: the release concludes `failure` with `reason`, naming the artifact that failed the gate. */
export class ReleasePublishRefused extends Schema.TaggedError<ReleasePublishRefused>()(
  "ReleasePublishRefused",
  {
    conclusion: Schema.Literal("failure"),
    reason: ReleaseRefusalReason,
    artifact: Schema.String,
    digest: Schema.String,
    /** The statement that lists a restored cache entry; absent when no statement names the digest. */
    envelopeDigest: Schema.optional(Schema.String),
  },
) {}

/** One artifact the publish step uploads. */
export interface ReleaseArtifact {
  readonly name: string;
  /** `sha256:<hex>` of the bytes the publish step uploads. */
  readonly digest: string;
  /** The release execution that built the artifact. */
  readonly executionId: string;
}

/** A public provenance key, current or retired, with its `kid`. */
export type ProvenancePublicKey = JsonWebKey & { readonly kid: string };

/** The logged cloud-builder statement that admits one artifact's publish. */
export interface ReleaseStatement {
  readonly artifact: string;
  readonly envelopeDigest: string;
  readonly entry: LogEntry;
}

const Descriptor = Schema.Struct({
  name: Schema.optional(Schema.String),
  digest: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  annotations: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
type Descriptor = typeof Descriptor.Type;

const LeaseClaim = Schema.Struct({ execution_id: Schema.String, binding_kind: BindingKind });

const SlsaClaims = Schema.Struct({
  subject: Schema.Array(Descriptor),
  predicateType: Schema.Literal(SLSA_PROVENANCE_V1),
  predicate: Schema.Struct({
    buildDefinition: Schema.Struct({
      internalParameters: Schema.Struct({ lease: LeaseClaim }),
      resolvedDependencies: Schema.Array(Descriptor),
    }),
  }),
});

const TestResultClaims = Schema.Struct({
  subject: Schema.Array(Descriptor),
  predicateType: Schema.Literal(TEST_RESULT_V0_1),
  predicate: Schema.Struct({ configuration: Schema.Array(Descriptor) }),
});

const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(DsseEnvelope));
const decodeSlsa = Schema.decodeUnknownOption(SlsaClaims);
const decodeTestResult = Schema.decodeUnknownOption(TestResultClaims);
const decodeLease = Schema.decodeUnknownOption(LeaseClaim);

/** What the gate reads from a statement's payload. */
interface ReleaseClaims {
  readonly lease: typeof LeaseClaim.Type;
  readonly subjectDigests: readonly string[];
  /** The restored cache entries the statement lists, as `cache:<namespace>/<key>` descriptors. */
  readonly restoredCache: readonly Descriptor[];
}

const sha256Subjects = (subject: readonly Descriptor[]) =>
  subject.flatMap((s) => (s.digest?.["sha256"] === undefined ? [] : [`sha256:${s.digest["sha256"]}`]));

const restoredCacheOf = (descriptors: readonly Descriptor[]) =>
  descriptors.filter((d) => d.name?.startsWith("cache:") === true);

const claimsOf = (payload: Uint8Array): ReleaseClaims | undefined => {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return undefined;
  }
  const slsa = Option.getOrUndefined(decodeSlsa(json));
  if (slsa !== undefined)
    return {
      lease: slsa.predicate.buildDefinition.internalParameters.lease,
      subjectDigests: sha256Subjects(slsa.subject),
      restoredCache: restoredCacheOf(slsa.predicate.buildDefinition.resolvedDependencies),
    };
  const gate = Option.getOrUndefined(decodeTestResult(json));
  if (gate === undefined) return undefined;
  const lease = Option.getOrUndefined(
    decodeLease(gate.predicate.configuration.find((d) => d.name === "lease")?.annotations),
  );
  if (lease === undefined) return undefined;
  return {
    lease,
    subjectDigests: sha256Subjects(gate.subject),
    restoredCache: restoredCacheOf(gate.predicate.configuration),
  };
};

/** Whether the envelope carries at least one signature and every one verifies under the provenance key it names. */
const signedByCloudBuilder = async (
  envelope: DsseEnvelope,
  keys: ReadonlyMap<string, ProvenancePublicKey>,
): Promise<boolean> => {
  if (envelope.signatures.length === 0) return false;
  for (const signature of envelope.signatures) {
    const key = keys.get(signature.keyid);
    if (key === undefined || !(await verifyDsseSignature(key, envelope, signature))) return false;
  }
  return true;
};

interface CloudStatement extends ReleaseClaims {
  readonly envelopeDigest: string;
  readonly entry: LogEntry;
}

/**
 * The execution's `platform` statements from a cloud builder: logged, bound by its execution lease, and signed by a
 * provenance key alone.
 */
const cloudStatementsOf = (executionId: string, keys: ReadonlyMap<string, ProvenancePublicKey>) =>
  Effect.gen(function* () {
    const store = yield* LogAppendStore;
    const intents = yield* store.forExecution(executionId);
    const out: CloudStatement[] = [];
    for (const intent of intents) {
      const entry = LogAppendStatus.$match(intent.status, {
        Pending: () => undefined,
        Logged: (logged) => logged.entry,
      });
      if (entry === undefined) continue;
      const envelope = Option.getOrUndefined(decodeEnvelope(intent.envelope));
      if (envelope === undefined) continue;
      const payload = fromBase64(envelope.payload);
      const claims = payload === undefined ? undefined : claimsOf(payload);
      if (
        claims === undefined ||
        claims.lease.binding_kind !== "execution-lease" ||
        claims.lease.execution_id !== executionId
      )
        continue;
      if (!(yield* Effect.promise(() => signedByCloudBuilder(envelope, keys)))) continue;
      out.push({ ...claims, envelopeDigest: intent.envelopeDigest, entry });
    }
    return out;
  });

/**
 * Admits or refuses a release's publish. For each artifact, in order, the gate refuses with
 * `provenance: release statement missing` when no logged `platform` statement from a cloud builder for the artifact's
 * release execution names its digest (FD-PROV-062), and with `provenance: release built warm` when such a statement
 * lists a restored cache entry (FD-PROV-063). It answers the statement that admits each artifact when every artifact
 * passes. `provenanceKeys` is the provenance key history, retired keys included.
 */
export const gateReleasePublish = (
  artifacts: readonly ReleaseArtifact[],
  provenanceKeys: readonly ProvenancePublicKey[],
) =>
  Effect.gen(function* () {
    const keys = new Map(provenanceKeys.map((key) => [key.kid, key]));
    const byExecution = new Map<string, readonly CloudStatement[]>();
    const admitted: ReleaseStatement[] = [];
    for (const artifact of artifacts) {
      let statements = byExecution.get(artifact.executionId);
      if (statements === undefined) {
        statements = yield* cloudStatementsOf(artifact.executionId, keys);
        byExecution.set(artifact.executionId, statements);
      }
      const naming = statements.filter((s) => s.subjectDigests.includes(artifact.digest));
      if (naming.length === 0)
        return yield* Effect.fail(
          new ReleasePublishRefused({
            conclusion: "failure",
            reason: RELEASE_STATEMENT_MISSING,
            artifact: artifact.name,
            digest: artifact.digest,
          }),
        );
      const warm = naming.find((s) => s.restoredCache.length > 0);
      if (warm !== undefined)
        return yield* Effect.fail(
          new ReleasePublishRefused({
            conclusion: "failure",
            reason: RELEASE_BUILT_WARM,
            artifact: artifact.name,
            digest: artifact.digest,
            envelopeDigest: warm.envelopeDigest,
          }),
        );
      admitted.push({ artifact: artifact.name, envelopeDigest: naming[0]!.envelopeDigest, entry: naming[0]!.entry });
    }
    return admitted;
  });
