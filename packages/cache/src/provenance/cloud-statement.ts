// The cloud builder's statement (specs/provenance.md § Statement, FD-PROV-008). A cloud executor holds no device key,
// so when its result submission is accepted the control plane writes the statement itself: each subject digest comes
// from the artifact bytes the control plane stores in R2 at `artifacts/<execution_id>/<epoch>/<name>`, never from a
// digest the executor reports, and the provenance key signs the envelope as the cloud builder.
import { Effect, Schema } from "effect";
import { artifactPath } from "../artifacts.ts";
import { hex, sha256Hex, utf8 } from "../crypto.ts";
import { CacheBucket, type Bucket } from "../manifest.ts";
import {
  DSSE_PAYLOAD_TYPE,
  dssePae,
  ProvenanceKeyInvalid,
  signPae,
  unsignedEnvelope,
  type DsseEnvelope,
  type ProvenanceKey,
} from "./dsse.ts";

export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
export const TEST_RESULT_V0_1 = "https://in-toto.io/attestation/test-result/v0.1";
/** The SLSA `buildType` of every FlareDispatch build statement. */
export const BUILD_TYPE =
  "https://github.com/fractalboxdev/flare-dispatch/blob/main/specs/provenance.md#statement";

const Digest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/));
const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/));
/** A name: printable ASCII without whitespace, so no log line, diff hunk, prompt or source text fits in one. */
const Name = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,256}$/));
const NonNegativeInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

/** What the control plane knows of an accepted cloud execution when it writes the statement. */
export const CloudStatementInput = Schema.Struct({
  /** The execution lease the control plane granted the cloud executor, at the epoch whose result it accepted. */
  lease: Schema.Struct({
    execution_id: Id,
    epoch: NonNegativeInt,
    nonce: Id,
    executor_id: Id,
    executor_kind: Id,
    run: Schema.Struct({
      name: Name,
      kind: Schema.Literals(["build", "gate"]),
      definition_digest: Digest,
      inputs_digest: Digest,
    }),
    repository: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
    ref: Name,
    commit_sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}([0-9a-f]{24})?$/)),
    image_digest: Digest,
    class: Name,
    policy_version: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,64}$/)),
    confidentiality: Schema.Literals([
      "non-confidential",
      "unclassified",
      "confidential-model",
      "confidential-compute",
    ]),
  }),
  outcome: Schema.String.check(Schema.isPattern(/^[a-z_-]{1,32}$/)),
  commands: Schema.Array(Schema.Struct({ name: Name, exit_status: Schema.Number.check(Schema.isInt()) })),
  /** The artifact names the result submission carries; the bytes are read from R2, never digested by the executor. */
  artifacts: Schema.Array(Schema.Struct({ name: Name })),
  lockfiles: Schema.Array(Schema.Struct({ path: Name, digest: Digest })),
  restored_cache: Schema.Array(Schema.Struct({ namespace: Name, key: Name, digest: Digest })),
  egress_log_digest: Digest,
  step_log_digest: Digest,
  models: Schema.Array(Schema.Struct({ id: Name, tokens: NonNegativeInt })),
});
export type CloudStatementInput = typeof CloudStatementInput.Type;

export class CloudStatementFailed extends Schema.TaggedError<CloudStatementFailed>()(
  "CloudStatementFailed",
  {
    reason: Schema.Literals(["invalid-input", "artifact-missing", "r2"]),
    detail: Schema.String,
  },
) {}

export interface CloudStatement {
  readonly statement: Readonly<Record<string, unknown>>;
  /** The envelope, signed once, by the provenance key as the cloud builder. */
  readonly envelope: DsseEnvelope;
}

type DigestStreamCtor = new (algorithm: string) => WritableStream<Uint8Array> & {
  readonly digest: Promise<ArrayBuffer>;
};

/** The lowercase hex SHA-256 of an R2 object's bytes, streamed where the runtime has `crypto.DigestStream`. */
const objectSha256 = async (
  bucket: Bucket,
  path: string,
): Promise<string | null> => {
  const object = await bucket.get(path);
  if (object === null) return null;
  const DigestStream = (crypto as unknown as { DigestStream?: DigestStreamCtor }).DigestStream;
  if (DigestStream === undefined) return sha256Hex(new Uint8Array(await object.arrayBuffer()));
  const stream = new DigestStream("SHA-256");
  await object.body.pipeTo(stream);
  return hex(await stream.digest);
};

const digestSet = (digest: string) => ({ sha256: digest.slice("sha256:".length) });

const leaseBinding = (input: CloudStatementInput) => ({
  execution_id: input.lease.execution_id,
  epoch: input.lease.epoch,
  nonce: input.lease.nonce,
  executor_id: input.lease.executor_id,
  binding_kind: "execution-lease",
});

const inputDescriptors = (input: CloudStatementInput) => [
  {
    name: "commit",
    uri: `git+https://github.com/${input.lease.repository}@${input.lease.ref}`,
    digest: { gitCommit: input.lease.commit_sha },
  },
  { name: "image", digest: digestSet(input.lease.image_digest) },
  ...input.lockfiles.map((l) => ({ name: `lockfile:${l.path}`, digest: digestSet(l.digest) })),
  ...input.restored_cache.map((c) => ({
    name: `cache:${c.namespace}/${c.key}`,
    digest: digestSet(c.digest),
    annotations: { namespace: c.namespace, key: c.key },
  })),
];

const byproducts = (input: CloudStatementInput) => [
  { name: "egress-proxy-log", digest: digestSet(input.egress_log_digest) },
  { name: "step-log", digest: digestSet(input.step_log_digest) },
  ...input.models.map((m) => ({ name: `model:${m.id}`, annotations: { tokens: m.tokens } })),
];

const predicateOf = (input: CloudStatementInput) =>
  input.lease.run.kind === "build"
    ? {
        predicateType: SLSA_PROVENANCE_V1,
        predicate: {
          buildDefinition: {
            buildType: BUILD_TYPE,
            externalParameters: {
              run: input.lease.run.name,
              run_definition_digest: input.lease.run.definition_digest,
              repository: input.lease.repository,
              ref: input.lease.ref,
              commit_sha: input.lease.commit_sha,
              inputs_digest: input.lease.run.inputs_digest,
            },
            internalParameters: {
              lease: leaseBinding(input),
              class: input.lease.class,
              policy_version: input.lease.policy_version,
              confidentiality: input.lease.confidentiality,
            },
            resolvedDependencies: inputDescriptors(input),
          },
          runDetails: {
            builder: { id: `${input.lease.executor_kind}:${input.lease.executor_id}` },
            metadata: { invocationId: input.lease.execution_id },
            byproducts: byproducts(input),
          },
        },
      }
    : {
        predicateType: TEST_RESULT_V0_1,
        predicate: {
          result:
            input.outcome === "success" && input.commands.every((c) => c.exit_status === 0)
              ? "PASSED"
              : "FAILED",
          configuration: [
            { name: "lease", annotations: leaseBinding(input) },
            {
              name: "run-definition",
              digest: digestSet(input.lease.run.definition_digest),
              annotations: { run: input.lease.run.name, class: input.lease.class },
            },
            { name: "inputs", digest: digestSet(input.lease.run.inputs_digest) },
            ...inputDescriptors(input),
            ...byproducts(input),
          ],
          passedTests: input.commands.filter((c) => c.exit_status === 0).map((c) => c.name),
          warnedTests: [],
          failedTests: input.commands.filter((c) => c.exit_status !== 0).map((c) => c.name),
        },
      };

/**
 * Writes and signs the statement of an accepted cloud execution (FD-PROV-008): one subject per artifact, digested from
 * the bytes stored in R2 at that execution and epoch, or the commit when it stored none; the SLSA provenance v1
 * predicate for a build recipe and the test-result predicate for a gate recipe; and one signature, by the provenance
 * key, as the cloud builder. An artifact the submission names but R2 does not hold fails the write.
 */
export const writeCloudStatement = (
  raw: unknown,
  key: ProvenanceKey,
): Effect.Effect<CloudStatement, CloudStatementFailed | ProvenanceKeyInvalid, CacheBucket> =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(CloudStatementInput)(raw).pipe(
      Effect.mapError((e) => new CloudStatementFailed({ reason: "invalid-input", detail: e.message })),
    );
    const bucket = yield* CacheBucket;
    const subject: Record<string, unknown>[] = [];
    for (const artifact of input.artifacts) {
      const path = artifactPath(input.lease.execution_id, input.lease.epoch, artifact.name);
      const sha256 = yield* Effect.tryPromise({
        try: () => objectSha256(bucket, path),
        catch: (e) => new CloudStatementFailed({ reason: "r2", detail: String(e) }),
      });
      if (sha256 === null)
        return yield* Effect.fail(
          new CloudStatementFailed({ reason: "artifact-missing", detail: artifact.name }),
        );
      subject.push({ name: artifact.name, digest: { sha256 } });
    }
    const statement = {
      _type: STATEMENT_TYPE,
      subject:
        subject.length === 0 ? [{ name: "commit", digest: { gitCommit: input.lease.commit_sha } }] : subject,
      ...predicateOf(input),
    };
    const payload = utf8(JSON.stringify(statement));
    const signature = yield* Effect.tryPromise({
      try: () => signPae(key, dssePae(DSSE_PAYLOAD_TYPE, payload)),
      catch: () =>
        new ProvenanceKeyInvalid({ kid: key.kid, message: "the provenance key does not import" }),
    });
    return { statement, envelope: { ...unsignedEnvelope(payload), signatures: [signature] } };
  });
