// A job matrix parent's child executions (specs/runs/gate.md § Job matrix): `MatrixChildren` over the admission intake
// uses, for a parent that runs in the control plane. Each job is admitted through mameko's one admission function under
// the parent (MAMEKO-RUN-080), keyed by its dedup key `<parent dedup key>/<job key>` (FD-GATE-031), at the job's class
// or the parent's, with its job check where the matrix sets `checkPerJob` (FD-GATE-046). The parent waits for each
// child's terminal row in mameko's store, the row mameko's terminal write sets once the child's class has no retry left
// (MAMEKO-ADM-083), and cancels a job through mameko's cancel path (FD-GATE-042).
import {
  ChildStartFailed,
  ExecutionLease,
  MatrixChildren,
  Outcome,
  type CancelCause,
  type ChildRequest,
  type ChildVerdict,
  type NotApplicableDetail,
  type Reason,
} from "@fractalboxdev/flare-dispatch-catalog";
import { dedupKey, executionId as newExecutionId } from "@fractalboxdev/mameko-coordinator";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Clock, Deferred, Duration, Effect, Layer, Match, Ref } from "effect";
import {
  Admission,
  boundsOf,
  IntakeConfig,
  intakeError,
  type IntakeAdmitInput,
  type IntakeError,
} from "./config.ts";
import { IntakeStore, StoreUnavailable, TERMINAL_STATUSES, type IntakeRecord } from "./store.ts";
import {
  admissionPlacement,
  dataClassRefusal,
  queuedUnstarted,
  sourceOf,
  submission,
} from "./submit.ts";

/** How often the parent reads its awaited children's rows. */
export const CHILD_POLL_MS = 5_000;

/** The cause a job carries when its parent cancels it: the parent ended before the job did (MAMEKO-RUN-088). */
export const CHILD_CANCEL_CAUSE = "parent-ended";

/** The rows one status read names; mameko's store reads them in one statement. */
const STATUS_READ_IDS = 50;

/** A child as admission answered it. */
export interface AdmittedChild {
  readonly executionId: string;
  /** The job's dedup key already named this execution, so admission created none. */
  readonly duplicate: boolean;
}

/** The commit a job runs at: its input's `sha`, which a discovery job sets to the base, else the parent's. */
const shaOf = (inputs: unknown, parent: IntakeRecord): string => {
  const sha = (inputs as { readonly sha?: unknown } | null)?.sha;
  return typeof sha === "string" ? sha : parent.sha;
};

/**
 * Admits one job as a child of `parentExecutionId` through intake's admission (MAMEKO-RUN-080). The child takes the
 * parent's trigger, repository, labels and data classes, its own run and inputs, the request's class or else the
 * parent's, which admission clamps to the parent's rank (MAMEKO-ADM-006), and the request's check. Its intake record
 * carries the parent's run and the job key as its label, so the check concludes under the name it opened with,
 * `flare-dispatch/<run>:<job key>`. A dedup key that already names an execution answers it, so a replayed parent
 * admits no second child (FD-GATE-031).
 */
export const admitChild = (
  parentExecutionId: string,
  request: ChildRequest,
): Effect.Effect<
  AdmittedChild,
  IntakeError | StoreUnavailable,
  IntakeConfig | Admission | IntakeStore
> =>
  Effect.gen(function* () {
    const config = yield* IntakeConfig;
    const admission = yield* Admission;
    const store = yield* IntakeStore;
    const now = yield* Clock.currentTimeMillis;
    const parent = yield* store.get(parentExecutionId);
    if (parent === null)
      return yield* Effect.fail(
        intakeError(404, "not_found", `no intake record of parent ${parentExecutionId}`),
      );
    const run = config.catalog(request.run);
    if (run === undefined)
      return yield* Effect.fail(
        intakeError(503, "misconfigured", `the catalogue serves no run ${request.run}`),
      );
    // A job's inputs carry no credential, as a request's do not (FD-AGT-008).
    if (config.writeCredentialIn(request.input) !== null)
      return yield* Effect.fail(
        intakeError(400, "invalid_inputs", `job ${request.key} inputs hold a write credential`),
      );
    const className = request.className ?? parent.className;
    yield* boundsOf(config.profile, className);
    const key = yield* Effect.promise(() =>
      dedupKey([{ name: "matrix-job", run: (k: string) => k }], request.dedupKey),
    );
    const sha = shaOf(request.input, parent);
    const s = submission({
      run,
      trigger: parent.trigger,
      label: request.key,
      repo: parent.repo,
      sha,
      ref: parent.ref,
      inputs: request.input,
      installation: parent.installation,
      cacheTrigger: parent.cacheTrigger,
      placementConstraint: parent.placementConstraint,
      repositoryPublic: parent.repositoryPublic,
      inputAssociations: parent.inputAssociations,
    });
    const confidentiality = config.confidentiality(parent.repo);
    const id = newExecutionId(now, Math.random);
    const record: IntakeRecord = {
      executionId: id,
      trigger: parent.trigger,
      run: parent.run,
      label: request.key,
      repo: parent.repo,
      sha,
      ref: parent.ref,
      inputs: request.input,
      className,
      labels: parent.labels,
      attempt: 1,
      familyRoot: id,
      installation: parent.installation,
      caller: parent.caller,
      notBefore: null,
      spendLine: parent.spendLine,
      placementConstraint: parent.placementConstraint,
      cacheTrigger: parent.cacheTrigger,
      eligibleKinds: null,
      repositoryPublic: parent.repositoryPublic,
      inputAssociations: parent.inputAssociations,
      createdAt: now,
    };
    const admitInput: IntakeAdmitInput = {
      executionId: id,
      scopeId: parent.repo,
      run: run.name,
      className,
      labels: parent.labels,
      enqueuedAtMs: now,
      dedup: {
        sha256: key.sha256,
        canonical: key.canonical,
        requestDigest: null,
        digestBody: null,
        onMismatch: "duplicate",
      },
      placement: admissionPlacement(config.profile, s, className, parent.labels, confidentiality),
      maxDurationSec: run.maxDurationSec,
      grants: run.grants ?? { setup: [], agent: [] },
      source: sourceOf(s),
      requiresWorkspace: run.requiresWorkspace === true,
      check: request.checkName === undefined ? null : { name: request.checkName, headSha: sha },
      refusal: dataClassRefusal(config.profile, s, confidentiality),
      runRetries: run.retries,
      parentExecutionId,
    };
    // The record goes in first, so an executor that claims the moment admission commits finds the inputs.
    yield* store.put(record);
    const admitted = yield* admission.admit(admitInput).pipe(
      Effect.catchTags({
        IntakeUnavailable: (e) =>
          Effect.andThen(
            store.drop(id),
            Effect.fail(intakeError(503, "intake_unavailable", `admission failed: ${e.cause}`)),
          ),
        ExecutionStartFailed: queuedUnstarted,
      }),
    );
    return yield* Match.value(admitted).pipe(
      Match.tag("Queued", ({ executionId }) =>
        Effect.gen(function* () {
          yield* store.placed(executionId);
          yield* admission.queued(className);
          return { executionId, duplicate: false };
        }),
      ),
      Match.tag("Concluded", ({ executionId }) =>
        Effect.as(store.placed(executionId), { executionId, duplicate: false }),
      ),
      Match.tag("Duplicate", ({ executionId }) =>
        Effect.as(store.drop(id), { executionId, duplicate: true }),
      ),
      Match.tag("Conflict", ({ executionId }) =>
        Effect.andThen(
          store.drop(id),
          Effect.fail(
            intakeError(409, "conflict", `job ${request.key} conflicts with ${executionId}`),
          ),
        ),
      ),
      Match.exhaustive,
    );
  });

/** A child's terminal row as the parent reads it: its status and reason. */
interface ChildRow {
  readonly id: string;
  readonly status: string;
  readonly reason: string | null;
}

/**
 * The verdict a child's terminal row records (FD-GATE-041): its run's `success`, `failure` with the reason, `cancelled`
 * with the cause or `skipped` with the detail, and no recorded verdict for a `failure` without a reason or a class
 * outcome, `deferred` or `expired`, which no run returns (MAMEKO-RUN-086).
 */
export const childVerdictOf = (status: string, reason: string | null): ChildVerdict =>
  Match.value(status).pipe(
    Match.when("success", (): ChildVerdict => ({ _tag: "Recorded", outcome: Outcome.success() })),
    Match.when("failure", (): ChildVerdict =>
      reason === null || reason === ""
        ? { _tag: "NoVerdict" }
        : { _tag: "Recorded", outcome: Outcome.failure(reason as Reason) },
    ),
    Match.when("cancelled", (): ChildVerdict => ({
      _tag: "Recorded",
      outcome: Outcome.cancelled((reason ?? "operator-cancel") as CancelCause),
    })),
    Match.when("skipped", (): ChildVerdict => {
      // mameko records a skip's reason as `<reason>: <detail>` or as the detail alone.
      const text = reason ?? "";
      const colon = text.indexOf(":");
      const detail = colon === -1 ? text : text.slice(colon + 1).trim();
      return { _tag: "Recorded", outcome: Outcome.skipped(detail as NotApplicableDetail) };
    }),
    Match.orElse((): ChildVerdict => ({ _tag: "NoVerdict" })),
  );

const readRows = (db: D1Like, ids: readonly string[]) =>
  Effect.tryPromise({
    try: async () => {
      const rows: ChildRow[] = [];
      for (let i = 0; i < ids.length; i += STATUS_READ_IDS) {
        const chunk = ids.slice(i, i + STATUS_READ_IDS);
        const { results } = await db
          .prepare(
            `select id, status, reason from mameko_executions where id in (${chunk.map(() => "?").join(", ")})`,
          )
          .bind(...chunk)
          .all();
        rows.push(...(results as ChildRow[]));
      }
      return rows;
    },
    catch: (cause) => new StoreUnavailable({ message: `child status: ${String(cause)}` }),
  });

export interface MatrixChildrenOptions {
  /** How often the parent reads its awaited children's rows; `CHILD_POLL_MS` when absent. */
  readonly pollMs?: number;
}

/**
 * `MatrixChildren` for the execution `ExecutionLease` names, over intake's admission and mameko's store on `db`.
 *
 * - `start` admits the job as a child of the execution (`admitChild`); a failed admission is `ChildStartFailed`.
 * - `await` answers once the child's row is terminal. One fiber reads every awaited child's row each `pollMs`; a read
 *   that fails is logged and read again at the next poll, so a store outage never reports a child as missing
 *   (MAMEKO-RUN-087). The parent's deadline bounds the wait (MAMEKO-RUN-085).
 * - `cancel` cancels the child through mameko's cancel path with cause `parent-ended` (FD-GATE-042).
 * - `discover` answers `infra: DiscoveryUnavailable`: mameko's store keeps no job output the parent could read.
 */
export const matrixChildrenLayer = (
  db: D1Like,
  options: MatrixChildrenOptions = {},
): Layer.Layer<MatrixChildren, never, ExecutionLease | IntakeConfig | Admission | IntakeStore> =>
  Layer.effect(
    MatrixChildren,
    Effect.gen(function* () {
      const lease = yield* ExecutionLease;
      const context = yield* Effect.context<IntakeConfig | Admission | IntakeStore>();
      const admission = yield* Admission;
      const pollMs = options.pollMs ?? CHILD_POLL_MS;
      const awaited = yield* Ref.make(new Map<string, Deferred.Deferred<ChildVerdict>>());

      const poll = Effect.gen(function* () {
        const waiting = yield* Ref.get(awaited);
        if (waiting.size === 0) return;
        const rows = yield* readRows(db, [...waiting.keys()]);
        for (const row of rows) {
          if (!TERMINAL_STATUSES.has(row.status)) continue;
          const deferred = waiting.get(row.id);
          if (deferred === undefined) continue;
          yield* Deferred.succeed(deferred, childVerdictOf(row.status, row.reason));
          yield* Ref.update(awaited, (m) => {
            const next = new Map(m);
            next.delete(row.id);
            return next;
          });
        }
      }).pipe(
        Effect.catchTag("StoreUnavailable", (e) =>
          Effect.logWarning("child status read failed; the next poll reads it again", {
            parent: lease.executionId,
            reason: e.message,
          }),
        ),
      );
      yield* Effect.forkScoped(
        Effect.forever(Effect.andThen(Effect.sleep(Duration.millis(pollMs)), poll)),
      );

      const startFailed = (request: ChildRequest) => (e: IntakeError | StoreUnavailable) =>
        Effect.fail(
          new ChildStartFailed({
            key: request.key,
            detail: e._tag === "IntakeError" ? `${e.code}: ${e.message}` : e.message,
          }),
        );

      return {
        start: (request) =>
          admitChild(lease.executionId, request).pipe(
            Effect.map(({ executionId }) => ({ key: request.key, executionId })),
            Effect.catchTags({
              IntakeError: startFailed(request),
              StoreUnavailable: startFailed(request),
            }),
            Effect.provide(context),
          ),
        await: (handle) =>
          Effect.gen(function* () {
            const fresh = yield* Deferred.make<ChildVerdict>();
            const deferred = yield* Ref.modify(awaited, (m) => {
              const held = m.get(handle.executionId);
              return held === undefined
                ? [fresh, new Map(m).set(handle.executionId, fresh)]
                : [held, m];
            });
            // A child that is already terminal answers at once.
            yield* poll;
            return yield* Deferred.await(deferred);
          }),
        cancel: (handle) =>
          admission.cancel(handle.executionId, CHILD_CANCEL_CAUSE).pipe(
            Effect.asVoid,
            Effect.catchTags({
              IntakeUnavailable: (e) =>
                Effect.logWarning("job cancel not recorded; the parent's end cancels it", {
                  executionId: handle.executionId,
                  reason: e.cause,
                }),
              IntakeError: (e) =>
                Effect.logWarning("job cancel refused; the parent's end cancels it", {
                  executionId: handle.executionId,
                  reason: e.message,
                }),
            }),
          ),
        discover: () =>
          Effect.succeed({
            _tag: "Ended" as const,
            outcome: Outcome.failure("infra: DiscoveryUnavailable"),
          }),
      };
    }),
  );
