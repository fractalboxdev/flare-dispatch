// `/v1/provenance/*`: the verification surface over statements. A statement is read only by lookup, on its execution
// id or on a `sha256` subject digest it names; no route searches, lists, exports or streams statements, verdicts or
// execution history (FD-PROV-071). Each statement answers with its log entry and the URL of its inclusion proof: the
// Rekor entry, whose answer carries the proof, or the private log's inclusion-proof route for its leaf. The check
// summary links the same URLs (FD-PROV-042).
import {
  sha256Subjects,
  statementSubjects,
} from "@fractalboxdev/flare-dispatch-cache/provenance-subjects";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { ApiConfig } from "../config.ts";
import { FlareDispatchApi, type StatementView } from "../declaration.ts";
import { apiError } from "../errors.ts";
import { ProvenanceStatements, type StatementRecord } from "../ports.ts";

/** The public Rekor instance whose entries the `rekor` log holds. */
export const REKOR_ORIGIN = "https://rekor.sigstore.dev";

/** The lookup of an execution's statements. */
export const statementUrl = (origin: string, executionId: string) =>
  `${origin}/v1/provenance/executions/${encodeURIComponent(executionId)}`;

/** The lookup of the statements naming a `sha256:<hex>` subject digest. */
export const subjectUrl = (origin: string, digest: string) =>
  `${origin}/v1/provenance/subjects/${digest}`;

/**
 * Where a logged statement's inclusion proof is read: Rekor's entry, whose answer carries `verification.inclusionProof`,
 * or the private log's inclusion proof of its leaf. `null` while the append is pending.
 */
export const inclusionProofUrl = (
  origin: string,
  record: StatementRecord,
  rekorOrigin: string = REKOR_ORIGIN,
): string | null =>
  record.entry === null
    ? null
    : record.log === "rekor"
      ? `${rekorOrigin}/api/v1/log/entries/${encodeURIComponent(record.entry.entryId)}`
      : `${origin}/v1/provenance/log/proof/inclusion?leaf_index=${record.entry.logIndex}`;

/**
 * A statement's links as the check summary carries them (FD-PROV-042): the statement, its inclusion proof and a lookup
 * by each `sha256` subject digest; a pending append shows `log-pending` (FD-PROV-041).
 */
export const statementLinks = (origin: string, record: StatementRecord) => ({
  envelope_digest: record.envelopeDigest,
  status: record.entry === null ? ("log-pending" as const) : ("logged" as const),
  statement_url: statementUrl(origin, record.executionId),
  inclusion_proof_url: inclusionProofUrl(origin, record),
  subjects: sha256Subjects(statementSubjects(record.envelope)).map((digest) => ({
    digest,
    url: subjectUrl(origin, digest),
  })),
});

/** One statement as the lookups answer it. */
export const statementView = (origin: string, record: StatementRecord): StatementView => ({
  envelope_digest: record.envelopeDigest,
  execution_id: record.executionId,
  envelope: JSON.parse(record.envelope) as StatementView["envelope"],
  subjects: statementSubjects(record.envelope),
  log: record.log,
  status: record.entry === null ? "log-pending" : "logged",
  log_index: record.entry?.logIndex ?? null,
  entry_id: record.entry?.entryId ?? null,
  integrated_time: record.entry?.integratedTime ?? null,
  inclusion_proof_url: inclusionProofUrl(origin, record),
});

const answer = (records: readonly StatementRecord[], missing: string) =>
  Effect.gen(function* () {
    if (records.length === 0) return yield* apiError("not_found", missing);
    const { publicOrigin } = yield* ApiConfig;
    return { statements: records.map((r) => statementView(publicOrigin, r)) };
  });

export const ProvenanceHandlers = HttpApiBuilder.group(FlareDispatchApi, "provenance", (handlers) =>
  handlers
    .handle("byExecution", ({ params }) =>
      Effect.gen(function* () {
        const statements = yield* ProvenanceStatements;
        return yield* answer(
          yield* statements.byExecution(params.id),
          `no statement is recorded for execution ${params.id}`,
        );
      }),
    )
    .handle("bySubject", ({ params }) =>
      Effect.gen(function* () {
        const statements = yield* ProvenanceStatements;
        return yield* answer(
          yield* statements.bySubject(params.digest),
          `no statement names the subject ${params.digest}`,
        );
      }),
    )
    .handle("inclusionProof", ({ query }) =>
      Effect.gen(function* () {
        const statements = yield* ProvenanceStatements;
        const proof = yield* statements.inclusionProof(query.leaf_index);
        if (proof === null)
          return yield* apiError(
            "not_found",
            `no published checkpoint of the private log covers leaf ${query.leaf_index}`,
          );
        return {
          leaf_index: proof.leafIndex,
          tree_size: proof.treeSize,
          hashes: [...proof.hashes],
          checkpoint: proof.checkpoint,
        };
      }),
    ),
);
