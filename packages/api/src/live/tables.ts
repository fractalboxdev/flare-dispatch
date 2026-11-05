// FlareDispatch's own D1 tables beside mameko's: each execution's inputs and deadline, which mameko's admission does not
// store and the lease carries, and the identity that dispatched it, which cancel checks (FD-IFC-046).
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare";
import { Effect, Schema } from "effect";

export const EXECUTION_INPUTS_MIGRATION = `create table if not exists execution_inputs (
  execution_id text primary key,
  inputs_json text not null,
  deadline_at integer not null
)`;

export const EXECUTION_ORIGINS_MIGRATION = `create table if not exists execution_origins (
  execution_id text primary key,
  identity text not null,
  trigger text not null,
  ref text,
  workflow_ref text
)`;

/** Both tables; each statement is idempotent, so a Worker runs them on its first request. */
export const API_MIGRATIONS: readonly string[] = [
  EXECUTION_INPUTS_MIGRATION,
  EXECUTION_ORIGINS_MIGRATION,
];

export const runApiMigrations = async (db: D1Like): Promise<void> => {
  for (const sql of API_MIGRATIONS) await db.prepare(sql).run();
};

export class ExecutionInputsMissing extends Schema.TaggedError<ExecutionInputsMissing>()(
  "ExecutionInputsMissing",
  { executionId: Schema.String },
) {}

export interface StoredInputs {
  readonly inputs: unknown;
  readonly deadlineAtMs: number;
}

export interface ExecutionOrigin {
  readonly identity: string;
  readonly trigger: string;
  readonly ref: string | undefined;
  readonly workflowRef: string | undefined;
}

/** The rows written before admission, so a device that claims the moment admission commits finds the inputs. */
export const putExecutionRows = (
  db: D1Like,
  executionId: string,
  stored: StoredInputs,
  origin: ExecutionOrigin,
): Effect.Effect<void> =>
  Effect.promise(() =>
    db.batch([
      db
        .prepare(
          "insert into execution_inputs (execution_id, inputs_json, deadline_at) values (?, ?, ?)",
        )
        .bind(executionId, JSON.stringify(stored.inputs), stored.deadlineAtMs),
      db
        .prepare(
          "insert into execution_origins (execution_id, identity, trigger, ref, workflow_ref) values (?, ?, ?, ?, ?)",
        )
        .bind(
          executionId,
          origin.identity,
          origin.trigger,
          origin.ref ?? null,
          origin.workflowRef ?? null,
        ),
    ]),
  );

/** Removes the rows of an id admission did not keep, because the request was a duplicate. */
export const dropExecutionRows = (db: D1Like, executionId: string): Effect.Effect<void> =>
  Effect.promise(() =>
    db.batch([
      db.prepare("delete from execution_inputs where execution_id = ?").bind(executionId),
      db.prepare("delete from execution_origins where execution_id = ?").bind(executionId),
    ]),
  );

export const getExecutionInputs = (
  db: D1Like,
  executionId: string,
): Effect.Effect<StoredInputs, ExecutionInputsMissing> =>
  Effect.gen(function* () {
    const { results } = yield* Effect.promise(() =>
      db
        .prepare("select inputs_json, deadline_at from execution_inputs where execution_id = ?")
        .bind(executionId)
        .all(),
    );
    const row = results[0] as { inputs_json: string; deadline_at: number } | undefined;
    if (row === undefined) return yield* new ExecutionInputsMissing({ executionId });
    return { inputs: JSON.parse(row.inputs_json) as unknown, deadlineAtMs: row.deadline_at };
  });
