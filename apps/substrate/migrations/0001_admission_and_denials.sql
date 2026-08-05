-- Substrate admission semaphore (ADR-0004) + per-execution denial events (ADR-0005).
-- This database is bound to the substrate worker ONLY — that exclusivity is the
-- structural half of "one admission path".

CREATE TABLE IF NOT EXISTS sub_admissions (
  execution_id TEXT PRIMARY KEY, -- namespaced consumer:key
  consumer     TEXT NOT NULL,
  pool         TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('queued', 'admitted')),
  enqueued_at  INTEGER NOT NULL,
  admitted_at  INTEGER,
  heartbeat_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sub_admissions_pool_state
  ON sub_admissions (pool, state, heartbeat_at);

CREATE TABLE IF NOT EXISTS sub_denials (
  container_id TEXT NOT NULL,
  host         TEXT NOT NULL,
  method       TEXT NOT NULL,
  path         TEXT NOT NULL,
  reason       TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 1,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (container_id, host, method, path, reason)
);
