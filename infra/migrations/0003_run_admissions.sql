-- Migration number: 0003 	 run admissions
--
-- Global per-pool run admission semaphore (issue #109). A merge burst can
-- create more concurrent RunWorkflow instances than the container pool has
-- instances (`max_instances: 16` per class); the excess runs fail
-- ContainerLaunchFailed / PortNeverOpened and post red checks
-- indistinguishable from test failures. Every run therefore enqueues a row
-- here before its body starts and polls an atomic FIFO claim until a slot in
-- its pool frees; D1's single-writer serialization makes the conditional
-- UPDATE a real counting semaphore. Rows are heartbeated while held and
-- deleted on release; stale rows (crashed holders / dead waiters) stop
-- counting after their TTL and are lazily purged. See
-- @flare-dispatch/runtime-cf run-admission-d1.ts.

CREATE TABLE IF NOT EXISTS run_admissions (
  execution_id TEXT PRIMARY KEY,   -- ULID (time-ordered tiebreak)
  pool TEXT NOT NULL,              -- 'lean' | 'browser' (per container class; each has its own max_instances: 16)
  state TEXT NOT NULL,             -- 'queued' | 'admitted'
  enqueued_at INTEGER NOT NULL,    -- ms epoch; FIFO key + dispatch-age basis
  admitted_at INTEGER,             -- ms epoch; NULL while queued
  heartbeat_at INTEGER NOT NULL    -- liveness for BOTH queued and admitted rows
);
CREATE INDEX IF NOT EXISTS run_admissions_pool_state ON run_admissions(pool, state, enqueued_at);
