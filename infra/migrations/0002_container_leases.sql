-- Migration number: 0002 	 container leases
--
-- Per-container-id serialization lease. Two runs whose execution ids
-- normalise to the SAME sandbox container id (e.g. playwright-demo +
-- product-demo for one repo+sha, both demo-<owner>-<repo>-<sha12>) must not
-- execute concurrently in one container. The first to acquire holds this row,
-- and a peer waits until it is released (or the heartbeat goes stale and the
-- lease is reclaimed). D1's atomic conditional upsert makes the acquire a
-- real mutex. See @flare-dispatch/runtime-cf container-lease-d1.ts.

CREATE TABLE IF NOT EXISTS container_leases (
  container_id TEXT PRIMARY KEY,          -- the shared sandbox id
  holder TEXT NOT NULL,                   -- execution id currently holding it
  acquired_at INTEGER NOT NULL,           -- ms epoch
  heartbeat_at INTEGER NOT NULL           -- ms epoch of last liveness refresh
);
