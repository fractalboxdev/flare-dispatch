// @fractalbox/flare-dispatch-core — the `StepRunner` capability: the swappable step seam.
//
// `step(name, body, opts)` does NOT itself decide *how* a step is checkpointed.
// It delegates to the `StepRunner` service — a Context.Tag — so the durable
// boundary is a Layer choice, not baked into the DSL:
//
//   * Test / dev runtime: `StepRunnerInline` runs the body Effect inline (no
//     CF Workflow), records start/end into `ExecutionsService`. This is what
//     unit tests exercise.
//
//   * PR4's CF runtime: `StepRunnerCloudflare` (lives in @fractalbox/flare-dispatch-
//     runtime-cf) backs each `step()` call with `WorkflowStep.do(name, ...)`.
//     CF Workflows is imperative — `step.do` awaits a Promise and expects a
//     THROWN error to fail+retry a step — so that runner wraps the body with
//     the `runEffect` shim (step.ts) inside the `step.do` callback. Effect's
//     typed `E` channel is preserved end-to-end: a failure thrown at the
//     `step.do` boundary is re-failed back into the Effect channel by `step`.
//
// This is the seam PR4's `RunWorkflow` binds to: one `StepRunner` Layer per
// runtime, `step` itself unchanged. The interface is deliberately narrow — a
// single `run` method — so the live binding is a small surface to implement.
//
// Spec: specs/03-dsl.md § step + § The runEffect boundary shim.

import { Context, type Duration, type Effect, type Schema } from "effect";
import type { RunContext } from "../context";
import type { ApprovalTimedOut, EventPayloadInvalid, StepFailed } from "../errors";
import type { StepOpts } from "../step-opts";

/**
 * The contract a runtime supplies to back `step()`. `run` receives the step
 * name, the lazily-constructed body Effect, and the step options; it is
 * responsible for the durable checkpoint (or, in the test runtime, for running
 * the body inline) and for the `ExecutionsService` lifecycle records.
 *
 * `waitForEvent` is the human-in-the-loop checkpoint: hibernates the run until
 * an external signal arrives via `env.RUNS_WORKFLOW.get(wfId).sendEvent(...)`,
 * or times out with `ApprovalTimedOut`. Decoded payload mismatches surface as
 * `EventPayloadInvalid`. The Dispatcher signal route is
 * `POST /v1/admin/events/:wf_id` (specs/04-gha-integration.md, gated by
 * Cloudflare Access in production).
 *
 * The body's environment is `RunContext` — the runner threads the ambient
 * context through. The result Effect's environment is also `RunContext`
 * because recording the lifecycle itself needs `Executions` (part of
 * `RunContext`).
 */
export interface StepRunnerService {
  readonly run: <A, E>(
    name: string,
    body: () => Effect.Effect<A, E, RunContext>,
    opts?: StepOpts,
  ) => Effect.Effect<A, E | StepFailed, RunContext>;

  readonly waitForEvent: <P, I = unknown>(
    name: string,
    opts: {
      type: string;
      timeout: Duration.Duration | string;
      payloadSchema: Schema.Schema<P, I>;
    },
  ) => Effect.Effect<P, ApprovalTimedOut | EventPayloadInvalid, RunContext>;
}

/** Context.Tag — the step-execution strategy a run carries until a Layer binds it. */
export class StepRunner extends Context.Tag(
  "@fractalbox/flare-dispatch-core/StepRunner",
)<StepRunner, StepRunnerService>() {}
