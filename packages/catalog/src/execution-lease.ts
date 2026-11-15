// The lease one execution runs under, as the cloud executor's per-lease Layers read it: the execution id and epoch of
// the run payload, the run it executes, and the input the run decoded, which carries the values the control plane wrote for the lease
// (`cloudLease`). `perExecution` provides it inside each execution, for `runsFor` and the `control` pool's catalogue, so
// one run-catalogue bundle serves every lease.
import type { Artifact, Exec, Intents, RunResult, Workspace } from "@fractalboxdev/mameko-run";
import { Context, Effect, Layer, Schema } from "effect";

export class ExecutionLease extends Context.Service<
  ExecutionLease,
  {
    readonly executionId: string;
    readonly epoch: number;
    /** The catalogue name of the run the lease executes. */
    readonly run: string;
    /** The run's input as its schema decoded it. */
    readonly input: unknown;
  }
>()("@fractalboxdev/flare-dispatch-catalog/ExecutionLease") {}

/** The lease's input carries no executor value the run's per-lease Layers need, or carries one that does not decode. */
export class CloudLeaseMissing extends Schema.TaggedError<CloudLeaseMissing>()(
  "CloudLeaseMissing",
  { detail: Schema.String },
) {}

/** A per-lease Layer failed before the run body started; the run records `failure` with `infra: <tag>`. */
export interface LeaseLayerFailure {
  readonly _tag: string;
}

/** The runner's services a per-lease Layer may read beside `ExecutionLease`. */
export type LeaseLayerContext = ExecutionLease | Intents | Workspace | Exec | Artifact;

/** What `perExecution` reads of a run: its name, its workflow and the body its `layer` registers. */
interface RunBody {
  readonly spec: { readonly name: string };
  readonly workflow: unknown;
  readonly body: (input: never) => Effect.Effect<RunResult, never, unknown>;
}

/** The run payload fields a per-lease Layer reads. */
interface LeasePayload {
  readonly execution_id: string;
  readonly epoch: number;
  readonly input: unknown;
}

/**
 * `run` with its body registered on the engine inside each execution: `layer` is built there from the payload's
 * execution id, epoch and decoded input as `ExecutionLease`, beside the runner's services, so the one bundle serves
 * every lease. A Layer that fails ends the run with `failure` and `infra: <tag>` before the body starts; no default
 * stands in for a missing value.
 */
export const perExecution = <R extends RunBody, A>(
  run: R,
  layer: Layer.Layer<A, LeaseLayerFailure, LeaseLayerContext>,
): R & { readonly layer: Layer.Layer<never, never, unknown> } => {
  const body = run.body as (input: unknown) => Effect.Effect<RunResult, never, A>;
  const workflow = run.workflow as unknown as {
    readonly toLayer: (
      execute: (payload: LeasePayload) => Effect.Effect<RunResult, never, unknown>,
    ) => Layer.Layer<never, never, unknown>;
  };
  return {
    ...run,
    layer: workflow.toLayer((payload) =>
      body(payload.input).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(
              Layer.succeed(ExecutionLease, {
                executionId: payload.execution_id,
                epoch: payload.epoch,
                run: run.spec.name,
                input: payload.input,
              }),
            ),
          ),
        ),
        Effect.catch((failure: LeaseLayerFailure) =>
          Effect.succeed<RunResult>({ _tag: "failure", reason: `infra: ${failure._tag}` }),
        ),
      ),
    ),
  };
};
