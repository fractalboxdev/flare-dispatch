// `/v1/provenance/*`: the verification surface over statements. A statement is read only by lookup, on its execution
// id or on a `sha256` subject digest it names; no route searches, lists, exports or streams statements, verdicts or
// execution history (FD-PROV-071). A caller without identity reads only the statements of public repositories
// (FD-IFC-053); every other statement, and the private log's proofs, need an Access JWT (FD-IFC-054). Each statement
// answers with its log entry and the URL of its inclusion proof: the Rekor entry, whose answer carries the proof, or
// the private log's inclusion-proof route for its leaf. The check summary links the same URLs (FD-PROV-042).
import {
  sha256Subjects,
  statementSubjects,
} from "@fractalboxdev/flare-dispatch-cache/provenance-subjects";
import { Effect, Match } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { ApiConfig } from "../config.ts";
import { FlareDispatchApi, type StatementView } from "../declaration.ts";
import { apiError } from "../errors.ts";
import { CurrentIdentity } from "../identity.ts";
import { ProvenanceStatements, StatementVisibility, type StatementRecord } from "../ports.ts";

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

/**
 * The statements the caller may read. An Access identity reads every one. A caller without identity reads only the
 * statements of repositories whose visibility is `public` (FD-IFC-053); where none is, it answers 401
 * `unauthenticated` whether or not a statement of another repository exists, so a lookup without identity cannot learn
 * that a private repository's statement names a digest (FD-IFC-054).
 */
const readable = (records: readonly StatementRecord[]) =>
  Effect.gen(function* () {
    const visibility = yield* StatementVisibility;
    const publicOnly = Effect.gen(function* () {
      const open = yield* Effect.filter(records, (r) => visibility.isPublic(r.repository));
      if (open.length === 0)
        return yield* apiError(
          "unauthenticated",
          "an Access identity is required to read the statements of a repository that is not public",
        );
      return open;
    });
    return yield* Match.value(yield* CurrentIdentity).pipe(
      Match.tag("Access", () => Effect.succeed(records)),
      Match.orElse(() => publicOnly),
    );
  });

const answer = (records: readonly StatementRecord[], missing: string) =>
  Effect.gen(function* () {
    const served = yield* readable(records);
    if (served.length === 0) return yield* apiError("not_found", missing);
    const { publicOrigin } = yield* ApiConfig;
    return { statements: served.map((r) => statementView(publicOrigin, r)) };
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
