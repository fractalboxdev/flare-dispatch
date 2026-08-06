-- Two-tier model spend (ADR-0009) + the model-proxy token's revocation epoch
-- (ADR-0006). Same database as admission, and for the same reason: the cap has
-- to hold across isolates, and an eventually-consistent store turns
-- read → call → decrement into a way to overspend.

CREATE TABLE IF NOT EXISTS sub_model_budgets (
  -- 'execution' rows are keyed by the namespaced execution id; 'consumer' rows
  -- by the consumer identity the service binding established.
  scope           TEXT NOT NULL CHECK (scope IN ('execution', 'consumer')),
  subject         TEXT NOT NULL,
  -- Integer micro-USD. Floating-point dollars drift across thousands of
  -- sub-cent charges, and a cap that drifts is a cap nobody can reason about.
  spent_micro_usd INTEGER NOT NULL DEFAULT 0,
  cap_micro_usd   INTEGER NOT NULL,
  -- Bumped to revoke every model-proxy token minted for this subject.
  epoch           INTEGER NOT NULL DEFAULT 0,
  armed_at        INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (scope, subject)
);

CREATE INDEX IF NOT EXISTS idx_sub_model_budgets_updated
  ON sub_model_budgets (scope, updated_at);
