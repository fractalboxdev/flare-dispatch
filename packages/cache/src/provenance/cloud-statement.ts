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
import {
  StatementEvidenceFields,
  StatementLease,
  StatementName,
  statementOf,
  type ResourceDescriptor,
  type Statement,
} from "./statement.ts";

/**
 * What the control plane knows of an accepted cloud execution when it writes the statement: the execution lease it
 * granted the cloud executor, at the epoch whose result it accepted, and the run's evidence, the egress proxy's fetch
 * records among it (FD-PROV-006). Every field outside this schema is dropped on decode.
 */
export const CloudStatementInput = Schema.Struct({
  lease: StatementLease,
  ...StatementEvidenceFields,
  /** The artifact names the result submission carries; the bytes are read from R2, never digested by the executor. */
  artifacts: Schema.Array(Schema.Struct({ name: StatementName })),
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
  readonly statement: Statement;
  /** The envelope, signed once, by the provenance key as the cloud builder. */
  readonly envelope: DsseEnvelope;
}

type DigestStreamCtor = new (algorithm: string) => WritableStream<Uint8Array> & {
  readonly digest: Promise<ArrayBuffer>;
};

/** The lowercase hex SHA-256 of an R2 object's bytes, streamed where the runtime has `crypto.DigestStream`. */
const objectSha256 = async (bucket: Bucket, path: string): Promise<string | null> => {
  const object = await bucket.get(path);
  if (object === null) return null;
  const DigestStream = (crypto as unknown as { DigestStream?: DigestStreamCtor }).DigestStream;
  if (DigestStream === undefined) return sha256Hex(new Uint8Array(await object.arrayBuffer()));
  const stream = new DigestStream("SHA-256");
  await object.body.pipeTo(stream);
  return hex(await stream.digest);
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
      Effect.mapError(
        (e) => new CloudStatementFailed({ reason: "invalid-input", detail: e.message }),
      ),
    );
    const bucket = yield* CacheBucket;
    const subject: ResourceDescriptor[] = [];
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
    const statement = statementOf(
      { ...input, lease: { ...input.lease, binding_kind: "execution-lease" } },
      subject,
    );
    const payload = utf8(JSON.stringify(statement));
    const signature = yield* Effect.tryPromise({
      try: () => signPae(key, dssePae(DSSE_PAYLOAD_TYPE, payload)),
      catch: () =>
        new ProvenanceKeyInvalid({ kid: key.kid, message: "the provenance key does not import" }),
    });
    return { statement, envelope: { ...unsignedEnvelope(payload), signatures: [signature] } };
  });
