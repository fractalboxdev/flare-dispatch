// @fractalboxdev/flare-dispatch-core — the `executions` capability (D1 metadata writes).
//
// `ExecutionsService` records the run lifecycle into D1: one row per execution
// in `executions`, one row per step transition in `steps` (per the V0 D1
// schema in specs/05-byoc.md). `step` depends on this service — every
// `step(name, ...)` call records a start record and an end record — so the
// Tag is part of `RunContext` (see context.ts).
//
// Unlike the six capability namespaces, `executions` has no accessor object:
// runs never write execution metadata directly. `step` (the run frame) is the
// only caller, via the `ExecutionsService` Tag.
//
// Spec: specs/pm/plan.md § 3 (V0 layout), specs/05-byoc.md § D1 schema.

import { Context, type Effect } from "effect";

/** Terminal status of a finished step or execution. */
export type StepStatus = "success" | "failure";

/**
 * Terminal status of a finished EXECUTION row. Steps stay binary; an execution
 * additionally records `"skipped"` when its run bowed out for a capacity
 * reason (`RunSkipped`) — the dispatcher reports those as a `neutral`
 * check-run, and analytics must not count them as failures.
 */
export type ExecutionStatus = StepStatus | "skipped";

/** A step lifecycle record — written once at start, updated once at end. */
export type StepRecord = {
  readonly executionId: string;
  readonly name: string;
  /** epoch ms when the step body began. */
  readonly startedAt: number;
  /** epoch ms when the step body settled; absent while in-progress. */
  readonly completedAt?: number;
  /** "success" | "failure" once settled; absent while in-progress. */
  readonly status?: StepStatus;
  /** the `_tag` of the typed failure when `status === "failure"`. */
  readonly errorTag?: string;
  /** opaque metadata forwarded from `StepOpts.metadata`. */
  readonly metadata?: Record<string, unknown>;
};

/** An execution row — the parent of N step rows. */
export type ExecutionRecord = {
  readonly id: string;
  readonly run: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly status?: ExecutionStatus;
  /**
   * The execution id of the parent that spawned this one via `spawnChildRun`,
   * or absent for a top-level (dispatched / scheduled) execution. The lineage
   * column a fan-out parent reads back to join on its children's outcomes.
   */
  readonly parentExecutionId?: string;
};

/**
 * The service contract a runtime Layer implements. The live binding (PR4's
 * `D1ExecutionsLive`) issues `INSERT`/`UPDATE` against the D1 `executions` and
 * `steps` tables; the fake keeps in-memory tables for unit tests.
 */
export interface ExecutionsService {
  /** Record a fresh `executions` row. */
  readonly startExecution: (opts: {
    id: string;
    run: string;
    startedAt: number;
    /**
     * The spawning parent's execution id, when this row is a `spawnChildRun`
     * child. Persisted to the `executions.parent_execution_id` column so a
     * fan-out parent can enumerate its children. Omitted for top-level rows.
     */
    parentExecutionId?: string;
  }) => Effect.Effect<void>;

  /** Mark an `executions` row terminal. */
  readonly finishExecution: (opts: {
    id: string;
    completedAt: number;
    status: ExecutionStatus;
    /**
     * The run's terminal output, JSON-encoded. When provided, the live
     * runtime persists it to the `executions.summary_json` column so
     * `io.priorExecution` can recover it on the next execution in the
     * semantic family (specs/03-dsl.md § `io.priorExecution`). Omitted →
     * the column stays NULL.
     */
    summaryJson?: string;
  }) => Effect.Effect<void>;

  /** Record a `steps` row at step entry. */
  readonly startStep: (opts: {
    executionId: string;
    name: string;
    startedAt: number;
    metadata?: Record<string, unknown>;
  }) => Effect.Effect<void>;

  /** Update a `steps` row at step exit with its terminal status. */
  readonly finishStep: (opts: {
    executionId: string;
    name: string;
    completedAt: number;
    status: StepStatus;
    errorTag?: string;
  }) => Effect.Effect<void>;
}

/** Context.Tag — the D1 metadata-write dependency `step` carries. */
export class Executions extends Context.Tag("@fractalboxdev/flare-dispatch-core/Executions")<
  Executions,
  ExecutionsService
>() {}
