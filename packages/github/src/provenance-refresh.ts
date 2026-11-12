// The check-run update of a statement logged after its execution concluded (specs/provenance.md FD-PROV-042). The
// conclusion links each statement as it stands when the conclusion is applied; a statement whose append succeeds later
// would show `log-pending` for good. Once the append succeeds, an execution that has a `check.conclude` row gets one
// more, keyed `cp:check:provenance:<envelope digest>`, whose payload names the statement: the applier renders the
// conclusion again from the execution's records, now with the statement's inclusion proof and subject links. The row
// goes in through host-cloudflare's `insertOutboxRows`, which leaves a key that already has a row as it is, so a
// retried append inserts nothing more.
import { insertOutboxRows, type D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { newRow } from "@fractalboxdev/mameko-kernel";
import { Effect, Schema } from "effect";
import type { ConcludeKind } from "./child-intents.ts";

/** The intent key prefix of a logged statement's check-run update. */
export const PROVENANCE_REFRESH_KEY = "cp:check:provenance";

/** The `check.conclude` payload of a logged statement's update: the statement's envelope digest. */
export const ProvenanceLoggedPayload = Schema.Struct({ provenance_logged: Schema.String });

/** The control plane's store could not be read or written; the append is tried again. */
export class ProvenanceRefreshUnavailable extends Schema.TaggedError<ProvenanceRefreshUnavailable>()(
  "ProvenanceRefreshUnavailable",
  { message: Schema.String },
) {}

const attempt = <A>(what: string, f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (e) => new ProvenanceRefreshUnavailable({ message: `${what}: ${e}` }),
  });

const sha256Hex = (text: string) =>
  Effect.promise(async () => {
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    );
    return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
  });

/**
 * The execution whose check run a conclusion row exists for. An execution with none has not concluded: its conclusion,
 * when applied, reads the statement as logged, so it needs no update.
 */
const CONCLUDED = `select e.scope_id, e.class from executions e
  where e.id = ? and exists (select 1 from outbox o where o.execution_id = e.id and o.kind = 'check.conclude')`;

/**
 * Inserts the check-run update of a logged statement for an execution with a conclusion row (FD-PROV-042), and answers
 * whether the execution has one. A repeat for the same statement inserts nothing.
 */
export const insertProvenanceRefresh = (
  db: D1Like,
  kind: ConcludeKind,
  statement: { readonly executionId: string; readonly envelopeDigest: string },
  now: number,
) =>
  Effect.gen(function* () {
    const { results } = yield* attempt("execution", () =>
      db.prepare(CONCLUDED).bind(statement.executionId).all(),
    );
    const execution = (
      results as readonly { readonly scope_id: string; readonly class: string }[]
    )[0];
    if (execution === undefined) return false;
    const intentKey = `${PROVENANCE_REFRESH_KEY}:${statement.envelopeDigest}`;
    const payload: typeof ProvenanceLoggedPayload.Type = {
      provenance_logged: statement.envelopeDigest,
    };
    const payloadDigest = yield* sha256Hex(JSON.stringify(payload));
    yield* attempt("outbox insert", () =>
      insertOutboxRows(db, [
        {
          id: `${statement.executionId}:${intentKey}`,
          limitKey: execution.scope_id,
          tier: kind.tier,
          priority: kind.priority,
          classRank: kind.classRanks[execution.class] ?? 0,
          drawsReserve: kind.drawsReserve,
          intent: {
            executionId: statement.executionId,
            scopeId: execution.scope_id,
            intentKey,
            kind: "check.conclude",
            payload,
            payloadDigest,
            effectClass: kind.effectClass,
            attempts: 0,
          },
          row: newRow({ effectClass: kind.effectClass, insertedAt: now }),
        },
      ]),
    );
    return true;
  });
