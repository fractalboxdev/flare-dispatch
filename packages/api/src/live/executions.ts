// The execution record read from mameko's D1 tables (`executions`, `placements`, `executors`, `reservations`,
// `dedup_keys`) and FlareDispatch's `execution_origins`. No column of `execution_inputs` is read (FD-IFC-039).
import { checkConclusion, verdictOf } from "@fractalboxdev/flare-dispatch-github";
import type { ExecutionOutcome } from "@fractalboxdev/mameko-coordinator";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare";
import { Effect, Layer, Match } from "effect";
import type { ReportedStatus, VerdictName } from "../declaration.ts";
import { apiError } from "../errors.ts";
import { Executions, type ExecutionFilter, type ExecutionRecord } from "../ports.ts";

interface Row {
  readonly id: string;
  readonly run: string;
  readonly scope_id: string;
  readonly class: string;
  readonly status: string;
  readonly reason: string | null;
  readonly enqueued_at: number;
  readonly finished_at: number | null;
  readonly placement: string | null;
  readonly epoch: number | null;
  readonly accepted_epoch: number | null;
  readonly executor_id: string | null;
  readonly executor_kind: string | null;
  readonly hold_micro_usd: number | null;
  readonly metered_micro_usd: number | null;
  readonly hold_state: string | null;
  readonly dispatched_by: string | null;
  readonly local: number;
}

const SELECT = `select e.id, e.run, e.scope_id, e.class, e.status, e.reason, e.enqueued_at, e.finished_at,
    p.state as placement, p.epoch, p.accepted_epoch, p.executor_id, x.kind as executor_kind,
    r.hold_micro_usd, r.metered_micro_usd, r.state as hold_state, o.identity as dispatched_by,
    exists (select 1 from dedup_keys d where d.execution_id = e.id and d.canonical like 'local:%') as local
  from executions e
  left join placements p on p.execution_id = e.id
  left join executors x on x.executor_id = p.executor_id
  left join reservations r on r.execution_id = e.id
  left join execution_origins o on o.execution_id = e.id`;

/** mameko's `executions.status` as the API reports it (specs/interfaces.md § Execution status as the API reports it). */
export const reportedStatus = (status: string): ReportedStatus =>
  Match.value(status).pipe(
    Match.when("pending", () => "queued" as const),
    Match.when("running", () => "running" as const),
    Match.orElse(() => "done" as const),
  );

const STATUS_SQL: Readonly<Record<ReportedStatus, string>> = {
  queued: "e.status = 'pending'",
  running: "e.status = 'running'",
  done: "e.status not in ('pending', 'running')",
};

const VERDICTS: ReadonlySet<string> = new Set(["success", "failure", "cancelled", "skipped"]);

/** The outcome a terminal row records, for the one verdict-to-conclusion mapping of specs/github-output.md. */
const outcomeOf = (row: Row): ExecutionOutcome | undefined =>
  Match.value(row.status).pipe(
    Match.when("success", (): ExecutionOutcome => ({
      _tag: "Success",
      epoch: row.accepted_epoch ?? 1,
    })),
    Match.when("failure", (): ExecutionOutcome => ({
      _tag: "Failure",
      reason: row.reason ?? "failure",
      epoch: row.accepted_epoch,
    })),
    Match.when("cancelled", (): ExecutionOutcome => ({
      _tag: "Cancelled",
      cause: row.reason ?? "cancelled",
    })),
    Match.when("skipped", (): ExecutionOutcome => ({
      _tag: "Skipped",
      detail: row.reason ?? "",
      epoch: row.accepted_epoch ?? 1,
    })),
    Match.orElse(() => undefined),
  );

export const recordOf = (row: Row): ExecutionRecord => {
  const outcome = outcomeOf(row);
  return {
    execution_id: row.id,
    run: row.run,
    repository: row.scope_id,
    class: row.class,
    status: reportedStatus(row.status),
    verdict: VERDICTS.has(row.status) ? (row.status as VerdictName) : null,
    reason: row.reason,
    conclusion: outcome === undefined ? null : checkConclusion(verdictOf(outcome)).conclusion,
    advisory: row.local === 1,
    placement: row.placement,
    executor_id: row.executor_id,
    executor_kind: row.executor_kind,
    epoch: row.epoch,
    accepted_epoch: row.accepted_epoch,
    reserved_micro_usd: row.hold_micro_usd,
    settled_micro_usd: row.hold_state === "settled" ? row.metered_micro_usd : null,
    enqueued_at: row.enqueued_at,
    finished_at: reportedStatus(row.status) === "done" ? (row.finished_at ?? null) : null,
    dispatchedBy: row.dispatched_by,
  };
};

const unreadable = () => apiError("unavailable", "the execution record could not be read");

export const listQuery = (
  filter: ExecutionFilter,
): { readonly sql: string; readonly binds: unknown[] } => {
  const where: string[] = [];
  const binds: unknown[] = [];
  const eq = (column: string, value: string | undefined) => {
    if (value === undefined) return;
    where.push(`${column} = ?`);
    binds.push(value);
  };
  eq("e.run", filter.run);
  eq("e.scope_id", filter.repository);
  eq("e.class", filter.class);
  eq("x.kind", filter.executorKind);
  if (filter.status !== undefined) where.push(STATUS_SQL[filter.status]);
  if (filter.finishedSince !== undefined) {
    where.push("e.finished_at >= ?");
    binds.push(filter.finishedSince);
  }
  if (filter.before !== undefined) {
    where.push("e.id < ?");
    binds.push(filter.before);
  }
  binds.push(filter.limit + 1);
  return {
    sql: `${SELECT}${where.length === 0 ? "" : ` where ${where.join(" and ")}`} order by e.id desc limit ?`,
    binds,
  };
};

export const d1Executions = (db: D1Like): Layer.Layer<Executions> =>
  Layer.succeed(Executions)({
    list: (filter) =>
      Effect.tryPromise({
        try: async () => {
          const { sql, binds } = listQuery(filter);
          const { results } = await db
            .prepare(sql)
            .bind(...binds)
            .all();
          const rows = (results as Row[]).map(recordOf);
          return { rows: rows.slice(0, filter.limit), more: rows.length > filter.limit };
        },
        catch: unreadable,
      }),
    get: (id) =>
      Effect.tryPromise({
        try: async () => {
          const { results } = await db.prepare(`${SELECT} where e.id = ?`).bind(id).all();
          const row = results[0] as Row | undefined;
          return row === undefined ? undefined : recordOf(row);
        },
        catch: unreadable,
      }),
  });
