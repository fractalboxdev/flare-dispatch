// The floor canary the deploy runs once on the deployed image digest (specs/operability.md FD-OPS-050): the control
// plane's `POST /v1/ops/floor-canary` admits one canary as an ops run on a Container pool, and
// `GET /v1/ops/floor-canary/:id` answers its verdict (MAMEKO-OPS-012, MAMEKO-OPS-018). The control plane supplies the
// port; a deploy that runs no canary answers both routes `not_configured`.
import type {
  FloorCanaryStarted,
  FloorCanaryVerdictBody,
} from "@fractalboxdev/flare-dispatch-api/declaration";
import { Context, Schema, type Effect } from "effect";

/** The pool names no Container pool the floor canary runs on. */
export class FloorCanaryPoolUnknown extends Schema.TaggedError<FloorCanaryPoolUnknown>()(
  "FloorCanaryPoolUnknown",
  { pool: Schema.String, pools: Schema.Array(Schema.String) },
) {}

/** The canary could not be admitted or its execution read: admission or the store did not answer. */
export class FloorCanaryUnavailable extends Schema.TaggedError<FloorCanaryUnavailable>()(
  "FloorCanaryUnavailable",
  { reason: Schema.String },
) {}

/** The control plane's floor canary: one admission on a pool, and the verdict of an admitted canary. */
export class FloorCanary extends Context.Service<
  FloorCanary,
  {
    /** Admits one canary on `pool`, or on the first canary pool when absent. */
    readonly start: (
      pool: string | undefined,
    ) => Effect.Effect<FloorCanaryStarted, FloorCanaryPoolUnknown | FloorCanaryUnavailable>;
    readonly verdict: (
      executionId: string,
    ) => Effect.Effect<FloorCanaryVerdictBody, FloorCanaryUnavailable>;
  }
>()("@fractalboxdev/flare-dispatch-ops/FloorCanary") {}
