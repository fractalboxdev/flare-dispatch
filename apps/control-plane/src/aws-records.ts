// The control plane's records of `image-publish` and `stack-deploy` (specs/runs/gate.md § AWS builds and stack
// deploys): the build ledger, one row per execution and target, which a later epoch reads so it polls the build already
// running and never starts a second one (FD-GATE-121); and the stack approvals, one row per execution that waits,
// which an operator's decision fills once (FD-GATE-136, FD-IFC-104 to FD-IFC-106).
import {
  BuildLedger,
  ExecutionLease,
  LedgerUnavailable,
  StackApprovals,
  type ApprovalDecision,
} from "@fractalboxdev/flare-dispatch-catalog";
import { apiError } from "@fractalboxdev/flare-dispatch-api/errors";
import { StackApprovalDecisions } from "@fractalboxdev/flare-dispatch-api/ports";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect, Layer } from "effect";

export const AWS_RECORDS_SCHEMA = [
  `create table if not exists aws_builds (
    execution_id text not null,
    target text not null,
    build_id text not null,
    started_at integer not null,
    primary key (execution_id, target))`,
  `create table if not exists stack_approvals (
    execution_id text primary key,
    sha text not null,
    stack text not null,
    requested_at integer not null,
    decision text,
    decided_by text,
    reason text,
    request_id text,
    decided_at integer)`,
];

const migrated = new WeakMap<D1Like, Promise<unknown>>();

/** Creates the tables once per database handle; a failed migration is retried on the next call. */
export const migrateAwsRecords = (db: D1Like): Promise<unknown> => {
  const existing = migrated.get(db);
  if (existing !== undefined) return existing;
  const run = (async () => {
    for (const sql of AWS_RECORDS_SCHEMA) await db.prepare(sql).run();
  })().catch((e: unknown) => {
    migrated.delete(db);
    throw e;
  });
  migrated.set(db, run);
  return run;
};

const query = <A>(db: D1Like, f: () => Promise<A>) =>
  Effect.tryPromise({
    try: async () => {
      await migrateAwsRecords(db);
      return await f();
    },
    catch: (cause) => new LedgerUnavailable({ detail: String(cause).slice(0, 300) }),
  });

/** The build ledger and the approval record of the execution its `ExecutionLease` names. */
export const awsRecordsLayer = (
  db: D1Like,
  now: () => number = Date.now,
): Layer.Layer<BuildLedger | StackApprovals, never, ExecutionLease> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { executionId } = yield* ExecutionLease;
      const ledger = Layer.succeed(BuildLedger, {
        recorded: (target) =>
          query(db, () =>
            db
              .prepare("select build_id from aws_builds where execution_id = ? and target = ?")
              .bind(executionId, target)
              .all(),
          ).pipe(
            Effect.map(
              ({ results }) => (results[0] as { build_id?: string } | undefined)?.build_id,
            ),
          ),
        record: (target, buildId) =>
          query(db, () =>
            db
              .prepare(
                `insert into aws_builds (execution_id, target, build_id, started_at) values (?, ?, ?, ?)
                 on conflict (execution_id, target) do nothing`,
              )
              .bind(executionId, target, buildId, now())
              .run(),
          ).pipe(Effect.asVoid),
      });
      const approvals = Layer.succeed(StackApprovals, {
        request: (stack, sha) =>
          query(db, () =>
            db
              .prepare(
                `insert into stack_approvals (execution_id, sha, stack, requested_at) values (?, ?, ?, ?)
                 on conflict (execution_id) do nothing`,
              )
              .bind(executionId, sha, stack, now())
              .run(),
          ).pipe(Effect.asVoid),
        decision: () =>
          query(db, () =>
            db
              .prepare("select decision from stack_approvals where execution_id = ?")
              .bind(executionId)
              .all(),
          ).pipe(
            Effect.map(({ results }) => {
              const decision = (results[0] as { decision?: string | null } | undefined)?.decision;
              return decision === "approve" || decision === "reject"
                ? (decision as ApprovalDecision)
                : undefined;
            }),
          ),
      });
      return Layer.merge(ledger, approvals);
    }),
  );

/** One recorded decision, as the approval route answers it (FD-IFC-104). */
export interface ApprovalRecord {
  readonly execution_id: string;
  readonly sha: string;
  readonly stack: string;
  readonly decision: ApprovalDecision;
  readonly decided_by: string;
  readonly reason: string;
  readonly request_id: string;
  readonly decided_at: number;
}

/** Why no decision was recorded: no waiting row, or a decision already there (FD-IFC-105, FD-IFC-106). */
export type DecideRefusal = "not-awaiting" | "decided";

/**
 * Records `decision` on the execution's waiting row, once. The update matches only a row with no decision, so two
 * concurrent decisions record the first (FD-IFC-106).
 */
export const decideStackApproval = async (
  db: D1Like,
  request: {
    readonly executionId: string;
    readonly decision: ApprovalDecision;
    readonly identity: string;
    readonly reason: string;
    readonly requestId: string;
    readonly now: number;
  },
): Promise<ApprovalRecord | DecideRefusal> => {
  await migrateAwsRecords(db);
  await db
    .prepare(
      `update stack_approvals set decision = ?, decided_by = ?, reason = ?, request_id = ?, decided_at = ?
       where execution_id = ? and decision is null`,
    )
    .bind(
      request.decision,
      request.identity,
      request.reason,
      request.requestId,
      request.now,
      request.executionId,
    )
    .run();
  const { results } = await db
    .prepare(
      `select execution_id, sha, stack, decision, decided_by, reason, request_id, decided_at
       from stack_approvals where execution_id = ?`,
    )
    .bind(request.executionId)
    .all();
  const row = results[0] as
    | (Omit<ApprovalRecord, "decision"> & { decision: string | null })
    | undefined;
  if (row === undefined) return "not-awaiting";
  if (row.request_id !== request.requestId) return "decided";
  return { ...row, decision: row.decision as ApprovalDecision };
};

/** The execution's mameko status, or `undefined` where no execution has the id. */
const executionStatusOf = async (db: D1Like, executionId: string): Promise<string | undefined> => {
  const { results } = await db
    .prepare("select status from mameko_executions where id = ?")
    .bind(executionId)
    .all();
  return (results[0] as { status?: string } | undefined)?.status;
};

/** `StackApprovalDecisions` over the `stack_approvals` record (FD-IFC-104 to FD-IFC-106). */
export const stackApprovalDecisions = (
  db: D1Like,
  now: () => number = Date.now,
): Layer.Layer<StackApprovalDecisions> =>
  Layer.succeed(StackApprovalDecisions, {
    decide: (request) =>
      Effect.gen(function* () {
        const unavailable = () =>
          apiError("unavailable", "the stack approval record is unreadable");
        const status = yield* Effect.tryPromise({
          try: () => executionStatusOf(db, request.executionId),
          catch: unavailable,
        });
        if (status === undefined)
          return yield* apiError("execution_not_found", `no execution ${request.executionId}`);
        if (status !== "pending" && status !== "running")
          return yield* apiError(
            "not_awaiting_approval",
            `execution ${request.executionId} has ended`,
          );
        const answer = yield* Effect.tryPromise({
          try: () => decideStackApproval(db, { ...request, now: now() }),
          catch: unavailable,
        });
        if (answer === "not-awaiting")
          return yield* apiError(
            "not_awaiting_approval",
            `execution ${request.executionId} waits for no stack approval`,
          );
        if (answer === "decided")
          return yield* apiError(
            "conflict",
            `execution ${request.executionId} already has a decision`,
          );
        return answer;
      }),
  });
