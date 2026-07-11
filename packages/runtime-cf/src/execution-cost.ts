// @fractalbox/flare-dispatch-runtime-cf — per-execution cost rollup (the finish path).
//
// At `finishExecution` the Workflow calls `recordExecutionCost` to denormalize a
// cost rollup onto the `executions` row (the columns 0005 added). It combines:
//
//   * METERED model tokens — SUMmed from `execution_model_usage` (written per
//     call by the live `modelGateway` wrapper, model-gateway-cf.ts);
//   * MODELED container compute — `instance vCPU/mem rate × active seconds`,
//     where active seconds is the execution wall-time (an upper-bound proxy:
//     it includes model round-trips + any in-body waits; refining this to the
//     true sandbox boot→destroy window is a follow-up).
//
// via the pure `@fractalbox/flare-dispatch-core` cost engine, which decides the honest
// `metered | mixed | modeled | unmetered` basis. Best-effort: a cost-rollup
// failure logs a warning and never flips the run's verdict.
//
// Spec: specs/06-cost.md, infra/migrations/0005_execution_cost.sql.

import { Effect } from "effect";
import {
  type InstanceType,
  type SandboxImage,
  INSTANCE_SPECS,
  estimateExecutionCost,
} from "@fractalbox/flare-dispatch-core";

/**
 * The container instance type a run's `sandboxImage` lands on. The Durable
 * Object classes in wrangler.jsonc bind `lean`/`browser` → `standard-2` and
 * `agent` → `standard-3`; an un-set image defaults to `lean`.
 */
export const instanceForSandboxImage = (
  sandboxImage: SandboxImage | undefined,
): InstanceType => (sandboxImage === "agent" ? "standard-3" : "standard-2");

type UsageRow = {
  readonly model: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly metered: number;
};

/**
 * Compute and persist this execution's cost rollup. Reads its own wall-time and
 * model-usage rows from D1, models container compute from the instance type, and
 * writes the `executions` cost columns. Returns `void`; all failure is absorbed.
 *
 * @param db          D1 binding (`env.RUNS_METADATA`).
 * @param executionId the row to roll up.
 * @param instance    the container instance type (`instanceForSandboxImage`).
 */
export const recordExecutionCost = (opts: {
  readonly db: D1Database;
  readonly executionId: string;
  readonly instance: InstanceType;
}): Effect.Effect<void> =>
  Effect.tryPromise(async () => {
    const { db, executionId, instance } = opts;

    // Wall-time → modeled container-active seconds (upper-bound proxy).
    const exec = await db
      .prepare(`SELECT started_at, completed_at FROM executions WHERE id = ?`)
      .bind(executionId)
      .first<{ started_at: number | null; completed_at: number | null }>();
    const startedAt = exec?.started_at ?? null;
    const completedAt = exec?.completed_at ?? null;
    const activeSeconds =
      startedAt !== null && completedAt !== null && completedAt > startedAt
        ? (completedAt - startedAt) / 1000
        : 0;

    // SUM model token usage; pick the dominant model for the rate + the column.
    const usage = await db
      .prepare(
        `SELECT model, input_tokens, output_tokens, metered
           FROM execution_model_usage WHERE execution_id = ?`,
      )
      .bind(executionId)
      .all<UsageRow>();
    const rows = usage.results ?? [];

    let inTok = 0;
    let outTok = 0;
    let anyMetered = false;
    let dominant: { model: string; tok: number } | null = null;
    for (const r of rows) {
      inTok += r.input_tokens;
      outTok += r.output_tokens;
      if (r.metered === 1) anyMetered = true;
      const tok = r.input_tokens + r.output_tokens;
      if (dominant === null || tok > dominant.tok) dominant = { model: r.model, tok };
    }

    const cost = estimateExecutionCost({
      container: { instance, activeSeconds },
      ...(dominant !== null
        ? {
            model: {
              model: dominant.model,
              inputTokens: inTok,
              outputTokens: outTok,
              metered: anyMetered,
            },
          }
        : {}),
    });

    const vcpuSeconds = INSTANCE_SPECS[instance].vcpu * activeSeconds;

    await db
      .prepare(
        `UPDATE executions
           SET cost_micro_usd = ?, cost_basis = ?, input_tokens = ?,
               output_tokens = ?, vcpu_seconds = ?, model = ?
         WHERE id = ?`,
      )
      .bind(
        cost.totalMicroUsd,
        cost.basis,
        rows.length > 0 ? inTok : null,
        rows.length > 0 ? outTok : null,
        vcpuSeconds,
        dominant?.model ?? null,
        executionId,
      )
      .run();
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.logWarning(`recordExecutionCost failed (non-fatal): ${cause}`),
    ),
  );
