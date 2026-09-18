-- Migration number: 0007 	 serial queue
--
-- Per-group serialization for runs that declare `serialize` (worker-deploy:
-- one group per repo, branch, and checkLabel). At most one row per group is
-- 'running'; a newer dispatch marks every older 'queued' row of its group
-- 'superseded' in the same batch that inserts it, so the only live waiter is
-- the newest. A 'running' row is never touched by a newer dispatch. Rows are
-- heartbeated while held or waiting and deleted on release; a holder whose
-- heartbeat stales past its TTL stops blocking the group. See
-- @fractalboxdev/flare-dispatch-runtime-cf serial-queue-d1.ts.

CREATE TABLE IF NOT EXISTS serial_queue (
  execution_id TEXT PRIMARY KEY,
  group_key TEXT NOT NULL,          -- SerializeSpec.group
  revision TEXT NOT NULL,           -- SerializeSpec.revision (a commit SHA for a deploy)
  state TEXT NOT NULL,              -- 'queued' | 'running' | 'superseded'
  superseded_by TEXT,               -- revision of the dispatch that replaced a waiter
  enqueued_at INTEGER NOT NULL,     -- ms epoch; arrival order within a group
  heartbeat_at INTEGER NOT NULL     -- ms epoch; liveness for queued AND running rows
);
CREATE INDEX IF NOT EXISTS serial_queue_group_state ON serial_queue(group_key, state, enqueued_at);
