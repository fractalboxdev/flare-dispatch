-- Native dispatch intents retain nonce ownership across Workflow replays and ambiguous POST outcomes.
CREATE TABLE IF NOT EXISTS native_dispatches (
  repo TEXT NOT NULL,
  nonce TEXT NOT NULL,
  request_json TEXT NOT NULL,
  controller_app_id INTEGER NOT NULL,
  controller_login TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'dispatching', 'accepted', 'bound')),
  run_id INTEGER,
  run_attempt INTEGER,
  PRIMARY KEY (repo, nonce),
  CHECK ((state = 'bound' AND run_id IS NOT NULL AND run_attempt IS NOT NULL
      AND run_id > 0 AND run_attempt > 0)
    OR (state != 'bound' AND run_id IS NULL AND run_attempt IS NULL))
);
