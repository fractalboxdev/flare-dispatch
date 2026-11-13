// FlareDispatch's statement builder: the device extension's `statement` operation (specs/provenance.md § Statement).
// The device executor passes the lease, the outcome, each command's exit status and the digests it computed after the
// job sandbox exited; the builder answers an unsigned DSSE envelope whose payload is an in-toto Statement v1, and the
// device executor signs `dssePae(payloadType, payload)` through the key helper under the `statement` signing purpose
// (MAMEKO-EXEC-128).
import {
  CodeSigningHash,
  digestSet,
  StatementBody,
  StatementDigest,
  StatementName,
  statementOf,
  unsignedEnvelope,
  type DsseEnvelope,
  type Statement,
} from "@fractalboxdev/flare-dispatch-cache/provenance";
import { Effect, Schema } from "effect";

export {
  BUILD_TYPE,
  DSSE_PAYLOAD_TYPE,
  disallowedContent,
  dssePae,
  resolvedFetches,
  SLSA_PROVENANCE_V1,
  STATEMENT_TYPE,
  TEST_RESULT_V0_1,
  type DsseEnvelope,
  type ResourceDescriptor,
  type Statement,
} from "@fractalboxdev/flare-dispatch-cache/provenance";

/** The signing purpose the device executor signs a statement under (packages/profile `signing_purposes`). */
export const STATEMENT_SIGNING_PURPOSE = "statement";

/** What the device executor passes the builder. Every field outside this schema is dropped on decode (FD-PROV-001). */
export const StatementInput = Schema.Struct({
  ...StatementBody.fields,
  /**
   * The key helper's code-signing hash, in the form the device's registration record holds it (MAMEKO-LEASE-092):
   * lowercase hex of 20 or 32 bytes, with no algorithm prefix, which check 11 of the acceptance table compares.
   */
  code_hash: CodeSigningHash,
  /**
   * The digests the device executor computed from the detached output volume after the job sandbox exited. With none,
   * the commit is the statement's one subject, since in-toto Statement v1 requires at least one.
   */
  outputs: Schema.Array(Schema.Struct({ name: StatementName, digest: StatementDigest })),
});
export type StatementInput = typeof StatementInput.Type;

export class StatementInputInvalid extends Schema.TaggedError<StatementInputInvalid>()(
  "StatementInputInvalid",
  { message: Schema.String },
) {}

/**
 * The in-toto Statement v1 for one execution: subjects from the output digests the device executor passes, or the
 * commit when it passes none, the SLSA provenance v1 predicate for a build recipe and the test-result predicate for a
 * gate recipe (FD-PROV-001, -005, -007).
 */
export const buildStatement = (raw: unknown): Effect.Effect<Statement, StatementInputInvalid> =>
  Effect.map(
    Schema.decodeUnknownEffect(StatementInput)(raw).pipe(
      Effect.mapError((e) => new StatementInputInvalid({ message: e.message })),
    ),
    (input) =>
      statementOf(
        input,
        input.outputs.map((o) => ({ name: o.name, digest: digestSet(o.digest) })),
        { code_hash: input.code_hash },
      ),
  );

/** The statement as an unsigned DSSE envelope with payload type `application/vnd.in-toto+json` (FD-PROV-004). */
export const buildEnvelope = (raw: unknown): Effect.Effect<DsseEnvelope, StatementInputInvalid> =>
  Effect.map(buildStatement(raw), (statement) =>
    unsignedEnvelope(new TextEncoder().encode(JSON.stringify(statement))),
  );
