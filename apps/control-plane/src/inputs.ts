// FlareDispatch's table of each execution's inputs and deadline: mameko's admission stores neither, and the lease
// carries both.
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare";
import { Effect, Schema } from "effect";

export const EXECUTION_INPUTS_MIGRATION = `create table if not exists execution_inputs (
  execution_id text primary key,
  inputs_json text not null,
  deadline_at integer not null
)`;

export class ExecutionInputsMissing extends Schema.TaggedError<ExecutionInputsMissing>()(
  "ExecutionInputsMissing",
  { executionId: Schema.String },
) {}

export interface StoredInputs {
  readonly inputs: unknown;
  readonly deadlineAtMs: number;
}

export const putExecutionInputs = (
  db: D1Like,
  executionId: string,
  stored: StoredInputs,
): Effect.Effect<void> =>
  Effect.promise(() =>
    db
      .prepare(
        "insert into execution_inputs (execution_id, inputs_json, deadline_at) values (?, ?, ?)",
      )
      .bind(executionId, JSON.stringify(stored.inputs), stored.deadlineAtMs)
      .run(),
  );

/** Removes the row of an id admission did not keep, because the request was a duplicate. */
export const dropExecutionInputs = (db: D1Like, executionId: string): Effect.Effect<void> =>
  Effect.promise(() =>
    db.prepare("delete from execution_inputs where execution_id = ?").bind(executionId).run(),
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
