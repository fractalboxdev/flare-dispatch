// FlareDispatch's own D1 tables beside mameko's: each execution's inputs and deadline, which mameko's admission does not
// store and the lease carries, and the identity that dispatched it, which cancel checks (FD-IFC-046).
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare";
import { Schema } from "effect";

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
