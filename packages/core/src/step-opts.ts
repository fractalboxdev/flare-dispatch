// @fractalboxdev/flare-dispatch-core — StepOpts.
//
// Extracted into its own module so both `step` (step.ts) and the `StepRunner`
// service (services/step-runner.ts) can depend on the type without a cycle.
//
// Spec: specs/03-dsl.md § step.

export type StepOpts = {
  /** platform-level retry on infra failure (consumed by the CF StepRunner). */
  readonly retries?: number;
  /** Tagged failures `retries` applies to. Others fail at once. Omitted: all. */
  readonly retryOn?: readonly string[];
  readonly timeoutSec?: number;
  /** opaque metadata attached to the D1 `steps` record. */
  readonly metadata?: Record<string, unknown>;
};
