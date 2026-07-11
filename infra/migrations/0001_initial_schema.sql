-- Migration number: 0001 	 initial schema
--
-- FlareDispatch D1 schema V0 — execution and step metadata (verbatim from
-- specs/05-byoc.md § D1 schema). Logs and artifacts live in R2 — D1 holds
-- only pointers.
--
-- IF NOT EXISTS on every statement: databases provisioned before the
-- migrations framework already carry these tables (they were applied with a
-- one-shot `wrangler d1 execute infra/d1-schema.sql`). The first
-- `wrangler d1 migrations apply` on such a database must record this
-- migration as applied WITHOUT failing on the existing objects — on a fresh
-- database it creates everything.

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,                    -- ULID
  run TEXT NOT NULL,
  repo TEXT NOT NULL,
  ref TEXT NOT NULL,
  sha TEXT NOT NULL,
  status TEXT NOT NULL,                   -- queued | running | success | failure | cancelled
  started_at INTEGER,                     -- ms epoch
  completed_at INTEGER,
  parent_execution_id TEXT,               -- for matrix children
  input_json TEXT NOT NULL,
  summary_json TEXT,
  check_run_id INTEGER                    -- GitHub check-run id
);

CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  exit_code INTEGER,
  log_uri TEXT,                           -- R2 path
  attempt INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS executions_repo_sha ON executions(repo, sha);
CREATE INDEX IF NOT EXISTS steps_execution ON steps(execution_id);
