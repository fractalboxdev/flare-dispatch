// The statement lookups' port over the cache area's log-append intents (packages/cache/src/provenance/append.ts): an
// execution's intents, or the intents whose statement names a subject digest, each with its log entry once the append
// succeeded; and the private log's inclusion proof from the `TransparencyLog` object. A failed store read answers 503
// `unavailable`, never an empty lookup, since an empty answer reads as "no statement".
import {
  LogAppendStatus,
  LogAppendStore,
  type LogAppendIntent,
  type PrivateLogInclusionProof,
} from "@fractalboxdev/flare-dispatch-cache";
import { Effect, Layer } from "effect";
import { apiError } from "../errors.ts";
import { ProvenanceStatements, type StatementRecord } from "../ports.ts";

export const statementRecordOf = (intent: LogAppendIntent): StatementRecord => ({
  envelopeDigest: intent.envelopeDigest,
  executionId: intent.executionId,
  log: intent.log,
  envelope: intent.envelope,
  entry: LogAppendStatus.$match(intent.status, {
    Pending: () => null,
    Logged: ({ entry }) => ({
      logIndex: entry.logIndex,
      entryId: entry.entryId,
      integratedTime: entry.integratedTime,
    }),
  }),
});

const storeFailed = (e: { readonly message: string }) =>
  Effect.fail(apiError("unavailable", `the statement store failed: ${e.message}`));

/**
 * The port over the log-append store the layer provides and the private log's object; `privateLog` is `undefined` on
 * a deploy that binds no `TRANSPARENCY_LOG`, where an inclusion proof answers `unavailable`.
 */
export const provenanceStatements = (
  privateLog:
    | { inclusionProof(index: number): Promise<PrivateLogInclusionProof | null> }
    | undefined,
): Layer.Layer<ProvenanceStatements, never, LogAppendStore> =>
  Layer.effect(ProvenanceStatements)(
    Effect.gen(function* () {
      const store = yield* LogAppendStore;
      return {
        byExecution: (executionId) =>
          store.forExecution(executionId).pipe(
            Effect.map((intents) => intents.map(statementRecordOf)),
            Effect.catchTag("LogAppendStoreFailed", storeFailed),
          ),
        bySubject: (digest) =>
          store.forSubject(digest).pipe(
            Effect.map((intents) => intents.map(statementRecordOf)),
            Effect.catchTag("LogAppendStoreFailed", storeFailed),
          ),
        inclusionProof: (leafIndex) =>
          privateLog === undefined
            ? Effect.fail(apiError("unavailable", "this deploy binds no TRANSPARENCY_LOG object"))
            : Effect.tryPromise({
                try: () => privateLog.inclusionProof(leafIndex),
                catch: (e) =>
                  apiError(
                    "unavailable",
                    `the private log's checkpoint could not be read: ${e instanceof Error ? e.message : String(e)}`,
                  ),
              }),
      };
    }),
  );
