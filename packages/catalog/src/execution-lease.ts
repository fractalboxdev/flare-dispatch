// The lease one execution runs under, as the cloud executor's per-lease Layers read it: the execution id and epoch of
// the run payload, the run it executes, and the input the run decoded, which carries the values the control plane wrote for the lease
// (`cloudLease`). `runsFor` provides it inside each execution, so one run-catalogue bundle serves every lease.
import { Context, Schema } from "effect";

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
