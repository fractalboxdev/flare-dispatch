// The cloud builder (specs/provenance.md § Statement flow, FD-PROV-008, FD-PROV-009). A cloud executor holds no device
// key: it attaches the lease it was granted and the run's evidence to its `exec.result` as the result's `statement`.
// Once mameko's accept compare-and-set accepts that result, the control plane checks that the execution's current
// placement is that cloud executor at that epoch, writes the statement with each subject digest read from the artifact
// bytes it stores in R2, signs it with the provenance key as the cloud builder and records its log-append intent. The
// minute tick drains the intents into Rekor or the private log.
import {
  artifactSubjectRetention,
  type Bucket,
  CacheBucket,
  CloudAttestation,
  CloudStatementFailed,
  d1LogAppendStore,
  drainLogAppends,
  enqueueLogAppend,
  LogAppendFailed,
  LogAppendStore,
  parseProvenanceKey,
  PRIVATE_LOG_NAME,
  privateLogAppend,
  publicJwkOf,
  rekorAppend,
  RepositoryVisibility,
  SubjectRetention,
  TransparencyLogs,
  VisibilityUnreadable,
  writeCloudStatement,
} from "@fractalboxdev/flare-dispatch-cache";
import { GithubRead } from "@fractalboxdev/flare-dispatch-github";
import { d1IntakeStore, IntakeStore } from "@fractalboxdev/flare-dispatch-intake";
import type { TickStep } from "@fractalboxdev/flare-dispatch-ops";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect, Layer, Option, Schema } from "effect";
import { migrateCache } from "./cache-retention.ts";
import type { CacheEnv } from "./cache.ts";
import { apiEnvOf, type ControlPlaneEnv } from "./config.ts";
import { repositoryConfidentiality } from "./dev-repository.ts";
import { boundFetch, statementLoggedLayer } from "./github.ts";
import { issuedLeaseNonce } from "./lease.ts";

/**
 * Why the control plane signs no statement as the cloud builder for an accepted result (FD-PROV-009):
 * - `no-placement`: the execution has no placement row.
 * - `not-accepted`: the placement accepted no result.
 * - `stale-epoch`: the placement accepted a result at another epoch, its epoch moved past the result's, or the
 *   result's epoch nonce is invalidated.
 * - `other-executor`: the placement is leased to an executor other than the one the result arrived from.
 * - `device-executor`: the placement's executor is a device, which signs its own statement.
 * - `unregistered-executor`: the placement's executor has no registry row, so its kind is unknown.
 * - `binding-mismatch`: the attestation's lease binding differs from the control plane's records.
 * - `inputs-missing`: intake recorded no inputs for the execution.
 */
export const CloudBuilderRefusal = Schema.Literals([
  "no-placement",
  "not-accepted",
  "stale-epoch",
  "other-executor",
  "device-executor",
  "unregistered-executor",
  "binding-mismatch",
  "inputs-missing",
]);
export type CloudBuilderRefusal = typeof CloudBuilderRefusal.Type;

export class CloudBuilderRefused extends Schema.TaggedError<CloudBuilderRefused>()(
  "CloudBuilderRefused",
  {
    executionId: Schema.String,
    epoch: Schema.Number,
    reason: CloudBuilderRefusal,
    detail: Schema.String,
  },
) {}

/** The deploy leaves unset a binding the cloud builder signs or reads with: `PROVENANCE_KEY` or `CACHE`. */
export class CloudBuilderUnconfigured extends Schema.TaggedError<CloudBuilderUnconfigured>()(
  "CloudBuilderUnconfigured",
  { missing: Schema.String },
) {}

/** An `exec.result` the executor channel accepted: the execution, the epoch and the executor it arrived from. */
export interface AcceptedResult {
  readonly executionId: string;
  readonly epoch: number;
  readonly executorId: string;
}

/** The placement a cloud-builder statement binds: the cloud executor, its kind and the epoch's lease nonce. */
export interface CloudPlacement {
  readonly executorId: string;
  readonly executorKind: string;
  readonly nonce: string;
  readonly repository: string;
  readonly run: string;
  readonly className: string;
}

interface PlacementRow {
  readonly state: string;
  readonly epoch: number;
  readonly accepted_epoch: number | null;
  readonly executor_id: string | null;
  readonly executor_kind: string | null;
  readonly scope_id: string;
  readonly run: string;
  readonly class: string;
}

/**
 * The guard on every cloud-builder signature (FD-PROV-009): the execution's placement row accepted a result at
 * `epoch`, its epoch is still `epoch`, it is leased to the executor the result arrived from, that executor's registry
 * row names a kind other than `device`, and the epoch's lease nonce is still valid. Answers the placement, or the
 * first check that fails.
 */
export const cloudBuilderPlacement = (
  db: D1Like,
  accepted: AcceptedResult,
): Effect.Effect<CloudPlacement, CloudBuilderRefused> =>
  Effect.gen(function* () {
    const refuse = (reason: CloudBuilderRefusal, detail: string) =>
      Effect.fail(
        new CloudBuilderRefused({
          executionId: accepted.executionId,
          epoch: accepted.epoch,
          reason,
          detail,
        }),
      );
    const { results } = yield* Effect.promise(() =>
      db
        .prepare(
          `select p.state, p.epoch, p.accepted_epoch, p.executor_id, x.kind as executor_kind, e.scope_id, e.run, e.class
           from placements p join executions e on e.id = p.execution_id
           left join executors x on x.executor_id = p.executor_id
           where p.execution_id = ?`,
        )
        .bind(accepted.executionId)
        .all(),
    );
    const row = (results as readonly PlacementRow[])[0];
    if (row === undefined) return yield* refuse("no-placement", "the execution has no placement");
    if (row.accepted_epoch !== null && Number(row.accepted_epoch) !== accepted.epoch)
      return yield* refuse(
        "stale-epoch",
        `the placement accepted epoch ${row.accepted_epoch}, not ${accepted.epoch}`,
      );
    if (row.state !== "accepted" || row.accepted_epoch === null)
      return yield* refuse("not-accepted", `the placement is ${row.state}`);
    if (Number(row.epoch) !== accepted.epoch)
      return yield* refuse("stale-epoch", `the placement is at epoch ${row.epoch}`);
    if (row.executor_id !== accepted.executorId)
      return yield* refuse(
        "other-executor",
        `the placement is leased to ${row.executor_id ?? "no executor"}`,
      );
    if (row.executor_kind === null)
      return yield* refuse("unregistered-executor", `${row.executor_id} has no registry row`);
    if (row.executor_kind === "device")
      return yield* refuse("device-executor", `${row.executor_id} is a device executor`);
    const nonce = yield* issuedLeaseNonce(db, accepted.executionId, accepted.epoch);
    if (nonce === null)
      return yield* refuse("stale-epoch", `the nonce of epoch ${accepted.epoch} is invalidated`);
    return {
      executorId: row.executor_id,
      executorKind: row.executor_kind,
      nonce,
      repository: row.scope_id,
      run: row.run,
      className: row.class,
    };
  });

/** One row per (execution, epoch) the cloud builder signed for: the envelope digest of its logged statement. */
export const CLOUD_STATEMENT_SCHEMA = [
  `create table if not exists fd_cloud_statements (
     execution_id text not null,
     epoch integer not null,
     envelope_digest text not null,
     written_at integer not null,
     primary key (execution_id, epoch))`,
];

const migrated = new WeakMap<D1Like, Promise<unknown>>();

const migrateCloudStatements = (db: D1Like): Promise<unknown> => {
  const existing = migrated.get(db);
  if (existing !== undefined) return existing;
  const run = (async () => {
    await migrateCache(db);
    for (const sql of CLOUD_STATEMENT_SCHEMA) await db.prepare(sql).run();
  })().catch((e: unknown) => {
    migrated.delete(db);
    throw e;
  });
  migrated.set(db, run);
  return run;
};

/** What the cloud builder recorded for an accepted result: the statement's envelope digest and the log it goes to. */
export interface CloudStatementWritten {
  readonly envelopeDigest: string;
  /** False when the cloud builder had already signed for this execution and epoch, which it does once. */
  readonly inserted: boolean;
}

export type CloudBuilderEnv = Pick<ControlPlaneEnv, "DB" | "POLICY_RULES" | "DEPLOYMENT"> &
  Pick<CacheEnv, "CACHE"> & {
    readonly PROVENANCE_KEY?: string;
    readonly FD_DEV_REPOSITORY?: string;
  };

/** The fields of the attestation's lease binding each record of the control plane fixes. */
const bindingOf = (accepted: AcceptedResult, placement: CloudPlacement) =>
  ({
    execution_id: accepted.executionId,
    epoch: accepted.epoch,
    nonce: placement.nonce,
    executor_id: placement.executorId,
    executor_kind: placement.executorKind,
  }) as const;

/**
 * Writes and logs the cloud-builder statement of an accepted result (FD-PROV-008), once per execution and epoch. The
 * placement guard runs first (FD-PROV-009). The attestation's lease binding must equal the records: the execution,
 * the epoch, the epoch's nonce, the executor and its kind. The repository, run, class, commit, ref and confidentiality
 * mode come from the control plane's records, not the attestation; the subjects are the artifacts the control plane
 * stored for the execution at that epoch, each digested from its bytes in R2. The provenance key signs the statement,
 * and its log-append intent names the log the repository's visibility picks (FD-PROV-034, FD-PROV-035).
 */
export const writeAcceptedCloudStatement = (
  env: CloudBuilderEnv,
  accepted: AcceptedResult & { readonly attestation: unknown },
  now: number,
) =>
  Effect.gen(function* () {
    const key = parseProvenanceKey(apiEnvOf(env as unknown as ControlPlaneEnv).PROVENANCE_KEY);
    if (key === undefined)
      return yield* new CloudBuilderUnconfigured({ missing: "PROVENANCE_KEY" });
    const bucket = env.CACHE;
    if (bucket === undefined) return yield* new CloudBuilderUnconfigured({ missing: "CACHE" });
    const db = env.DB;
    const placement = yield* cloudBuilderPlacement(db, accepted);
    const query = <Row>(sql: string, ...values: unknown[]) =>
      Effect.promise(async () => {
        await migrateCloudStatements(db);
        const { results } = await db
          .prepare(sql)
          .bind(...values)
          .all();
        return results as readonly Row[];
      });
    const [signed] = yield* query<{ readonly envelope_digest: string }>(
      "select envelope_digest from fd_cloud_statements where execution_id = ? and epoch = ?",
      accepted.executionId,
      accepted.epoch,
    );
    if (signed !== undefined)
      return {
        envelopeDigest: signed.envelope_digest,
        inserted: false,
      } satisfies CloudStatementWritten;
    const attestation = yield* Schema.decodeUnknownEffect(CloudAttestation)(
      accepted.attestation,
    ).pipe(
      Effect.mapError(
        (e) => new CloudStatementFailed({ reason: "invalid-input", detail: e.message }),
      ),
    );
    const binding = bindingOf(accepted, placement);
    for (const field of Object.keys(binding) as (keyof typeof binding)[])
      if (attestation.lease[field] !== binding[field])
        return yield* new CloudBuilderRefused({
          executionId: accepted.executionId,
          epoch: accepted.epoch,
          reason: "binding-mismatch",
          detail: `lease.${field}`,
        });
    const record = yield* IntakeStore.use((s) => s.get(accepted.executionId)).pipe(
      Effect.provide(d1IntakeStore(db)),
    );
    if (record === null)
      return yield* new CloudBuilderRefused({
        executionId: accepted.executionId,
        epoch: accepted.epoch,
        reason: "inputs-missing",
        detail: "intake recorded no inputs for the execution",
      });
    const artifacts = yield* query<{ readonly name: string }>(
      `select name from artifacts where execution_id = ? and epoch = ? and r2_path is not null order by name`,
      accepted.executionId,
      accepted.epoch,
    );
    const { envelope } = yield* writeCloudStatement(
      {
        ...attestation,
        lease: {
          ...attestation.lease,
          run: { ...attestation.lease.run, name: placement.run },
          repository: placement.repository,
          ref: record.ref,
          commit_sha: record.sha,
          class: placement.className,
          confidentiality: repositoryConfidentiality(env as unknown as ControlPlaneEnv)(
            placement.repository,
          ),
        },
        artifacts: artifacts.map(({ name }) => ({ name })),
      },
      key,
    ).pipe(Effect.provideService(CacheBucket, bucket as unknown as Bucket));
    const intent = yield* enqueueLogAppend(
      {
        envelope,
        executionId: accepted.executionId,
        repository: placement.repository,
        verifiers: [publicJwkOf(key)],
      },
      now,
    ).pipe(Effect.provideService(LogAppendStore, d1LogAppendStore(db as unknown as D1Database)));
    yield* query(
      `insert into fd_cloud_statements (execution_id, epoch, envelope_digest, written_at) values (?, ?, ?, ?)
       on conflict (execution_id, epoch) do nothing`,
      accepted.executionId,
      accepted.epoch,
      intent.digest,
      now,
    );
    return { envelopeDigest: intent.digest, inserted: true } satisfies CloudStatementWritten;
  });

/** The repository visibility the log choice reads, over the isolate's `GithubRead`; a failed read is unreadable. */
export const repositoryVisibilityLayer = Layer.effect(
  RepositoryVisibility,
  Effect.gen(function* () {
    const read = yield* GithubRead;
    return {
      of: (repository: string) =>
        read
          .visibility(repository)
          .pipe(
            Effect.mapError((e) => new VisibilityUnreadable({ repository, message: String(e) })),
          ),
    };
  }),
);

const ResultSubmission = Schema.Struct({
  type: Schema.Literal("exec.result"),
  execution_id: Schema.String,
  epoch: Schema.Number,
  statement: Schema.optionalKey(Schema.Unknown),
});
const decodeSubmission = Schema.decodeUnknownOption(Schema.fromJsonString(ResultSubmission));

/** The `exec.result` a channel frame carries, with its attestation; `None` for every other frame. */
export const resultSubmissionOf = (frame: string) =>
  Option.map(decodeSubmission(frame), (m) => ({
    executionId: m.execution_id,
    epoch: m.epoch,
    attestation: m.statement,
  }));

/**
 * The executor channel's step after it handled an `exec.result` from `executorId`: the cloud-builder statement of the
 * result when the placement accepted it from that cloud executor. A device executor's result is the device's own
 * statement to sign, and is passed over; every other refusal or failure is logged, and the result stays accepted.
 */
export const cloudStatementOnResult = (
  env: CloudBuilderEnv,
  frame: string,
  executorId: string,
  now: number,
): Effect.Effect<void, never, RepositoryVisibility> =>
  Option.match(resultSubmissionOf(frame), {
    onNone: () => Effect.void,
    onSome: (submission) =>
      writeAcceptedCloudStatement(env, { ...submission, executorId }, now).pipe(
        Effect.flatMap((written) =>
          Effect.log("cloud-builder statement recorded", {
            executionId: submission.executionId,
            epoch: submission.epoch,
            ...written,
          }),
        ),
        Effect.catchTag("CloudBuilderRefused", (e) =>
          e.reason === "device-executor"
            ? Effect.void
            : Effect.logWarning("no cloud-builder statement for the result", {
                executionId: e.executionId,
                epoch: e.epoch,
                reason: e.reason,
                detail: e.detail,
              }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("cloud-builder statement not written", {
            executionId: submission.executionId,
            epoch: submission.epoch,
            cause,
          }),
        ),
      ),
  });

/**
 * What the log-append drain reads: the intents in D1, Rekor and the private log's `TransparencyLog` object, the
 * artifact rows a logged statement's retention extends (FD-PROV-075), and the summary refresh a logged statement
 * queues (FD-PROV-042). A deploy with no `TRANSPARENCY_LOG` binding fails each private-log append, so the intent stays
 * pending and retries.
 */
export const logAppendLayer = (env: ControlPlaneEnv) => {
  const db = env.DB as unknown as D1Database;
  const ns = env.TRANSPARENCY_LOG;
  return Layer.mergeAll(
    Layer.succeed(LogAppendStore)(d1LogAppendStore(db)),
    Layer.succeed(TransparencyLogs)({
      rekor: rekorAppend({ fetch: boundFetch }),
      private:
        ns === undefined
          ? () =>
              Effect.fail(
                new LogAppendFailed({
                  log: "private",
                  message: "this deploy binds no TRANSPARENCY_LOG object",
                }),
              )
          : privateLogAppend(ns.get(ns.idFromName(PRIVATE_LOG_NAME))),
    }),
    Layer.succeed(SubjectRetention)(artifactSubjectRetention(db)),
    statementLoggedLayer(env),
  );
};

/** The tick's drain of every log-append intent due now (FD-PROV-041), into Rekor or the private log. */
export const logAppendStep = (env: ControlPlaneEnv, now: number): TickStep => ({
  step: "log-appends",
  effect: Effect.promise(() => migrateCache(env.DB)).pipe(
    Effect.andThen(drainLogAppends(now)),
    Effect.provide(logAppendLayer(env)),
  ),
});
