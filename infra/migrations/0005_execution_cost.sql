-- Migration number: 0005 	 execution cost attribution
--
-- Per-execution cost attribution (the benchmark / FinOps surfaces). Two parts:
--
--   1. `execution_model_usage` — one row per (execution, model). The live
--      `modelGateway` wrapper (@flare-dispatch/runtime-cf model-gateway-cf.ts)
--      records token usage here on each successful model call. The PK is
--      DETERMINISTIC (`${execution_id}:${model}`) and writes are upsert-SUM, so a
--      Workflow eviction/resume that replays a memoized `step` body does NOT
--      double-count (the body isn't re-executed on resume). A genuine per-step
--      RETRY re-runs the calls and will over-count — accepted: this is a
--      best-effort cost estimate, not a billing meter, and a retry is itself a
--      transient-failure signal.
--
--      `metered = 1` means the gateway returned a real usage block (Anthropic /
--      Bedrock / DeepSeek). Workers AI catalog (`@cf/…`) returns none → tokens
--      stay 0 and `metered = 0` (account-billed Neurons, unmetered per-execution).
--
--   2. nullable cost columns on `executions` — the denormalized rollup the
--      dashboard list + analytics aggregate read without a join. Written at
--      `finishExecution` from the usage SUM + modeled container compute (see
--      runtime-cf execution-cost.ts, @flare-dispatch/core cost.ts). Nullable +
--      additive: pre-0005 rows and the hot list query are unaffected.

CREATE TABLE IF NOT EXISTS execution_model_usage (
  id TEXT PRIMARY KEY,                 -- `${execution_id}:${model}` (deterministic)
  execution_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  metered INTEGER NOT NULL DEFAULT 0,  -- 1 if the gateway returned a usage block
  updated_at INTEGER NOT NULL          -- ms epoch of the last write
);
CREATE INDEX IF NOT EXISTS execution_model_usage_exec ON execution_model_usage(execution_id);

-- Denormalized per-execution cost rollup. All nullable: a pre-0005 row, a
-- still-running execution, or a deploy without the cost path leaves these NULL.
ALTER TABLE executions ADD COLUMN cost_micro_usd INTEGER;  -- total, integer micro-USD
ALTER TABLE executions ADD COLUMN cost_basis TEXT;         -- metered | mixed | modeled | unmetered
ALTER TABLE executions ADD COLUMN input_tokens INTEGER;    -- summed model input tokens
ALTER TABLE executions ADD COLUMN output_tokens INTEGER;   -- summed model output tokens
ALTER TABLE executions ADD COLUMN vcpu_seconds REAL;       -- modeled container vCPU-seconds
ALTER TABLE executions ADD COLUMN model TEXT;              -- representative model (most tokens)

-- The per-recipe analytics aggregate groups by `run`.
CREATE INDEX IF NOT EXISTS executions_run ON executions(run);
