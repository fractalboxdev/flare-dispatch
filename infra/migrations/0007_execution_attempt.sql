-- Migration number: 0007 	 execution attempt lineage
--
-- A check-run re-run (the GitHub "Re-run" button → `check_run.rerequested`)
-- dispatches a FRESH execution of the same run, repo, SHA and inputs. The
-- execution id cannot be reused: Cloudflare Workflows refuses `create({ id })`
-- for any id it has seen, terminated or not. So a re-run is a new row, and
-- these two columns tie it back to the execution it retries:
--
--   * `attempt`  — 1 for a dispatched execution, N for the (N-1)th re-run.
--                  Pre-0007 rows are first attempts, so the default is exact.
--   * `retry_of` — the id of attempt 1 (the ROOT of the family), NULL on
--                  attempt 1 itself. Every attempt points at the root rather
--                  than at its predecessor, so one indexed lookup returns the
--                  whole family.
--
-- The `check_run_id` index serves the re-run lookup: the webhook names the
-- check-run, and the execution that posted it is found by that id.
ALTER TABLE executions ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE executions ADD COLUMN retry_of TEXT;
CREATE INDEX IF NOT EXISTS executions_retry_of ON executions(retry_of);
CREATE INDEX IF NOT EXISTS executions_check_run ON executions(check_run_id);
