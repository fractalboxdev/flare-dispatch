// The reproduction of a release (specs/provenance.md § Reproduction). Where a release rule sets `reproduce: true`, the
// control plane creates a second execution of the release's recipe on the release's commit, run definition and image:
// caches off, class `interactive`, under the `reproduction` placement constraint, which keeps it off `cloudflare`, `aws`
// and `gha` and on a device of the `attested-dedicated` posture tier (FD-PROV-064). The reproduction publishes nothing:
// the only intent of it the control plane applies is the log append of its statement, which is no outbox row
// (FD-PROV-065).
//
// Once both statements are logged, the control plane compares their subject digests. Equal digests yield a
// reproduction record, signed by the provenance key, naming both envelope digests and appended to the transparency log
// (FD-PROV-066). Any difference refuses the publish with `provenance: reproduction mismatch` and raises a page alarm
// (FD-PROV-067). No reproduction statement logged by the release's `deadline_at` concludes the release `failure` with
// `provenance: reproduction unavailable` (FD-PROV-068).
//
// A statement counts as the reproduction statement when it is logged by the release's `deadline_at`, its execution
// lease binds the reproduction execution, a provenance key countersigned it beside its builder's own signature, it
// lists no restored cache entry, and it names the release's commit, run-definition digest and image digest.
import {
  type Actuator,
  type ActuatorRegistry,
  actuatorRegistry,
  AlarmPort,
  type IntentRow,
} from "@fractalboxdev/mameko-ports";
import { Data, Effect, Option, Schema } from "effect";
import { utf8 } from "../crypto.ts";
import { enqueueLogAppend, LogAppendStore, publicJwkOf } from "./append.ts";
import {
  DSSE_PAYLOAD_TYPE,
  DsseEnvelope,
  dssePae,
  fromBase64,
  ProvenanceKeyInvalid,
  signPae,
  unsignedEnvelope,
  type ProvenanceKey,
} from "./dsse.ts";
import { loggedStatementsOf, type LoggedStatement, type ProvenancePublicKey } from "./release.ts";
import {
  REPRODUCTION_APPLIES_NO_INTENT,
  REPRODUCTION_MISMATCH,
  REPRODUCTION_RECORD_V1,
  REPRODUCTION_UNAVAILABLE,
  type ReleaseExecution,
} from "./reproduction-request.ts";
import { STATEMENT_TYPE } from "./statement.ts";

export * from "./reproduction-request.ts";

// ---------------------------------------------------------------------------
// The intent filter

/** Answers whether an execution is a reproduction execution, or fails when its record cannot be read. */
export type ReproductionLookup = (executionId: string) => Effect.Effect<boolean, { readonly message: string }>;

/**
 * The actuators with every outbox row of a reproduction execution refused (FD-PROV-065): its check runs, comments,
 * releases, uploads and follow-ons are never applied, and an adoptable or reconcile-only row finds nothing to adopt. Its
 * statement's log append is a `provenance_log_appends` row, not an outbox row, so it goes ahead. A row whose
 * execution cannot be read is retried rather than applied.
 */
export const reproductionGuardedActuators = (
  base: ActuatorRegistry,
  reproduction: ReproductionLookup,
): ActuatorRegistry => {
  const check = (row: IntentRow) =>
    row.executionId === null ? Effect.succeed(false) : reproduction(row.executionId);
  const guard = ({ apply, lookup, reconcile }: Actuator): Actuator => ({
    apply: (row) =>
      check(row).pipe(
        Effect.matchEffect({
          onFailure: (e) => Effect.succeed({ _tag: "retryable" as const, reason: e.message }),
          onSuccess: (is) =>
            is ? Effect.succeed({ _tag: "refused" as const, reason: REPRODUCTION_APPLIES_NO_INTENT }) : apply(row),
        }),
      ),
    ...(lookup === undefined
      ? {}
      : {
          lookup: (row) =>
            check(row).pipe(
              Effect.matchEffect({
                onFailure: (e) => Effect.succeed({ _tag: "undetermined" as const, reason: e.message }),
                onSuccess: (is) => (is ? Effect.succeed({ _tag: "absent" as const }) : lookup(row)),
              }),
            ),
        }),
    ...(reconcile === undefined
      ? {}
      : {
          reconcile: (row) =>
            check(row).pipe(
              Effect.matchEffect({
                onFailure: (e) => Effect.succeed({ _tag: "undetermined" as const, reason: e.message }),
                onSuccess: (is) => (is ? Effect.succeed({ _tag: "absent" as const }) : reconcile(row)),
              }),
            ),
        }),
  });
  return actuatorRegistry(Object.fromEntries(base.names().map((name) => [name, guard(base.get(name)!)])));
};

// ---------------------------------------------------------------------------
// The comparison

/** The release concludes `failure` with a reproduction reason; the publish is refused. */
export class ReproductionRefused extends Schema.TaggedError<ReproductionRefused>()("ReproductionRefused", {
  conclusion: Schema.Literal("failure"),
  reason: Schema.Literals([REPRODUCTION_MISMATCH, REPRODUCTION_UNAVAILABLE]),
  releaseExecutionId: Schema.String,
  reproductionExecutionId: Schema.String,
  /** Both statements' envelope digests, when both are logged. */
  releaseEnvelopeDigest: Schema.optional(Schema.String),
  reproductionEnvelopeDigest: Schema.optional(Schema.String),
}) {}

/** The release's statement is absent: the release gate (FD-PROV-062) refuses it before any comparison. */
export class ReleaseStatementAbsent extends Schema.TaggedError<ReleaseStatementAbsent>()(
  "ReleaseStatementAbsent",
  { releaseExecutionId: Schema.String },
) {}

/** Where a release's reproduction stands. */
export type ReproductionOutcome = Data.TaggedEnum<{
  /** No reproduction statement is logged yet, and the release's `deadline_at` has not passed. */
  Awaiting: {};
  /** The digests are equal; the reproduction record is signed and its log append recorded. */
  Reproduced: {
    readonly recordEnvelopeDigest: string;
    readonly releaseEnvelopeDigest: string;
    readonly reproductionEnvelopeDigest: string;
  };
}>;
export const ReproductionOutcome = Data.taggedEnum<ReproductionOutcome>();

/** The release and reproduction executions a comparison reads. */
export interface ReproductionPair {
  readonly release: ReleaseExecution;
  readonly reproductionExecutionId: string;
  /** The release's `deadline_at`, epoch milliseconds. */
  readonly deadlineAt: number;
}

const sameDigests = (a: readonly string[], b: readonly string[]) => {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((d, i) => d === y[i]);
};

/** A logged statement of the reproduction execution that reproduces the release's inputs cold. */
const reproducesInputs = (statement: LoggedStatement, release: ReleaseExecution) =>
  statement.provenanceSigned &&
  !statement.cloudBuilder &&
  statement.restoredCache.length === 0 &&
  statement.commit === release.commit &&
  statement.definitionDigest === release.definitionDigest &&
  statement.imageDigest === release.imageDigest;

const RecordClaims = Schema.Struct({
  predicateType: Schema.Literal(REPRODUCTION_RECORD_V1),
  predicate: Schema.Struct({
    release: Schema.Struct({ envelope_digest: Schema.String }),
    reproduction: Schema.Struct({ envelope_digest: Schema.String }),
  }),
});
const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(DsseEnvelope));
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(RecordClaims));

/** The reproduction record already recorded under the release execution for these two statements, if any. */
const existingRecord = (releaseExecutionId: string, release: string, reproduction: string) =>
  Effect.gen(function* () {
    const intents = yield* (yield* LogAppendStore).forExecution(releaseExecutionId);
    for (const intent of intents) {
      const envelope = Option.getOrUndefined(decodeEnvelope(intent.envelope));
      const payload = envelope === undefined ? undefined : fromBase64(envelope.payload);
      if (payload === undefined) continue;
      const record = Option.getOrUndefined(decodeRecord(new TextDecoder().decode(payload)));
      if (
        record?.predicate.release.envelope_digest === release &&
        record.predicate.reproduction.envelope_digest === reproduction
      )
        return intent.envelopeDigest;
    }
    return undefined;
  });

/** The reproduction record: the release's subjects and both envelope digests, signed by the provenance key. */
const signRecord = (
  pair: ReproductionPair,
  release: LoggedStatement,
  reproduction: LoggedStatement,
  key: ProvenanceKey,
) =>
  Effect.tryPromise({
    try: async (): Promise<DsseEnvelope> => {
      const record = {
        _type: STATEMENT_TYPE,
        subject: [...new Set(release.subjectDigests)]
          .sort()
          .map((d) => ({ digest: { sha256: d.slice("sha256:".length) } })),
        predicateType: REPRODUCTION_RECORD_V1,
        predicate: {
          release: { execution_id: pair.release.executionId, envelope_digest: release.envelopeDigest },
          reproduction: { execution_id: pair.reproductionExecutionId, envelope_digest: reproduction.envelopeDigest },
        },
      };
      const payload = utf8(JSON.stringify(record));
      const signature = await signPae(key, dssePae(DSSE_PAYLOAD_TYPE, payload));
      return { ...unsignedEnvelope(payload), signatures: [signature] };
    },
    catch: () => new ProvenanceKeyInvalid({ kid: key.kid, message: "the provenance key does not import" }),
  });

/**
 * Compares a release with its reproduction at `now`. With both statements logged and equal subject digests, it signs a
 * reproduction record naming both envelope digests with the active provenance key and records its log append, once
 * however often it runs (FD-PROV-066). With differing digests it raises a page alarm and fails with
 * `provenance: reproduction mismatch` (FD-PROV-067). With no reproduction statement whose log time is at or before the
 * release's `deadline_at`, it answers `Awaiting` before that time and fails with `provenance: reproduction unavailable`
 * from it on (FD-PROV-068).
 * `provenanceKeys` is the provenance key history, retired keys included.
 */
export const settleReproduction = (
  pair: ReproductionPair,
  provenanceKeys: readonly ProvenancePublicKey[],
  key: ProvenanceKey,
  now: number,
) =>
  Effect.gen(function* () {
    const keys = new Map(provenanceKeys.map((k) => [k.kid, k]));
    const releaseId = pair.release.executionId;
    const release = (yield* loggedStatementsOf(releaseId, keys)).find((s) => s.cloudBuilder);
    if (release === undefined)
      return yield* Effect.fail(new ReleaseStatementAbsent({ releaseExecutionId: releaseId }));
    // A statement logged after the deadline is too late; the log's integrated time decides (FD-PROV-040).
    const reproduction = (yield* loggedStatementsOf(pair.reproductionExecutionId, keys)).find(
      (s) => reproducesInputs(s, pair.release) && s.entry.integratedTime <= pair.deadlineAt,
    );
    if (reproduction === undefined) {
      if (now < pair.deadlineAt) return ReproductionOutcome.Awaiting();
      return yield* Effect.fail(
        new ReproductionRefused({
          conclusion: "failure",
          reason: REPRODUCTION_UNAVAILABLE,
          releaseExecutionId: releaseId,
          reproductionExecutionId: pair.reproductionExecutionId,
          releaseEnvelopeDigest: release.envelopeDigest,
        }),
      );
    }
    const digests = {
      releaseEnvelopeDigest: release.envelopeDigest,
      reproductionEnvelopeDigest: reproduction.envelopeDigest,
    };
    if (!sameDigests(release.subjectDigests, reproduction.subjectDigests)) {
      const alarms = yield* AlarmPort;
      yield* alarms
        .deliver({
          name: "reproduction-mismatch",
          severity: "page",
          dedupeKey: `reproduction:${releaseId}`,
          state: "raised",
          detail: {
            repository: pair.release.repository,
            release: { execution_id: releaseId, envelope_digest: release.envelopeDigest, subjects: release.subjectDigests },
            reproduction: {
              execution_id: pair.reproductionExecutionId,
              envelope_digest: reproduction.envelopeDigest,
              subjects: reproduction.subjectDigests,
            },
          },
        })
        .pipe(
          Effect.catchTag("AlarmDeliveryFailed", (e) =>
            Effect.logWarning("reproduction mismatch alarm undelivered", e.reason),
          ),
        );
      return yield* Effect.fail(
        new ReproductionRefused({
          conclusion: "failure",
          reason: REPRODUCTION_MISMATCH,
          releaseExecutionId: releaseId,
          reproductionExecutionId: pair.reproductionExecutionId,
          ...digests,
        }),
      );
    }
    const recorded = yield* existingRecord(releaseId, release.envelopeDigest, reproduction.envelopeDigest);
    if (recorded !== undefined) return ReproductionOutcome.Reproduced({ recordEnvelopeDigest: recorded, ...digests });
    const envelope = yield* signRecord(pair, release, reproduction, key);
    const intent = yield* enqueueLogAppend(
      { envelope, executionId: releaseId, repository: pair.release.repository, verifiers: [publicJwkOf(key)] },
      now,
    );
    return ReproductionOutcome.Reproduced({ recordEnvelopeDigest: intent.digest, ...digests });
  });
