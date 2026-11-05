// The MCP tools of specs/interfaces.md § MCP tools. Each control-plane tool takes its input and output schemas from the
// route it wraps (FD-IFC-077); `rehearse` and `lease_status` take theirs from the local scheduler operations they wrap.
// Both the dispatcher's `/mcp` and `fd mcp` serve these definitions.
import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { DispatchBody, Dispatched, ExecutionView, IncidentV1 } from "../declaration.ts";

/** The longest wait of `get_verdict` and `dispatch`, and of `rehearse` (FD-IFC-078). */
export const MAX_WAIT_S = 60;
export const MAX_REHEARSE_WAIT_S = 600;

/** The serialized size every tool result stays within (FD-IFC-079). */
export const MAX_TOOL_RESULT_BYTES = 16_384;

/**
 * A tool error: the error-model code of the route or operation that failed, as the tool's result rather than an MCP
 * protocol error (FD-IFC-080). A plain struct, so the server returns both fields instead of the message alone.
 */
export const ToolError = Schema.Struct({ error: Schema.String, message: Schema.String });
export type ToolError = typeof ToolError.Type;

const WaitSeconds = Schema.optionalKey(Schema.Number);
const ExecutionId = { execution_id: Schema.NonEmptyString };

export const DispatchTool = Tool.make("dispatch", {
  description:
    "Dispatch a run on a repository and commit through the control plane; with wait_seconds, wait up to 60 s for the verdict.",
  parameters: Schema.Struct({
    run: Schema.NonEmptyString,
    repo: DispatchBody.fields.repository,
    ref: DispatchBody.fields.ref,
    sha: DispatchBody.fields.sha,
    inputs: DispatchBody.fields.inputs,
    class: DispatchBody.fields.class,
    wait_seconds: WaitSeconds,
  }),
  success: Schema.Struct({ ...Dispatched.fields, verdict: Schema.optionalKey(ExecutionView) }),
  failure: ToolError,
});

export const GetVerdictTool = Tool.make("get_verdict", {
  description:
    "The status and verdict of one execution; with wait_seconds, wait up to 60 s for it to finish.",
  parameters: Schema.Struct({ ...ExecutionId, wait_seconds: WaitSeconds }),
  success: ExecutionView,
  failure: ToolError,
});

export const GetFailureSummaryTool = Tool.make("get_failure_summary", {
  description: "The bounded incident/v1 pack of a failed execution.",
  parameters: Schema.Struct(ExecutionId),
  success: IncidentV1,
  failure: ToolError,
});

export const CancelTool = Tool.make("cancel", {
  description: "Request cancellation of one execution.",
  parameters: Schema.Struct(ExecutionId),
  success: ExecutionView,
  failure: ToolError,
});

/** A local execution as the local scheduler's submit and outcome operations answer it. */
export const LocalExecution = Schema.Struct({
  execution_id: Schema.String,
  status: Schema.Literals(["queued", "running", "done"]),
  queue_position: Schema.NullOr(Schema.Number),
  verdict: Schema.NullOr(Schema.Literals(["success", "failure", "cancelled", "skipped"])),
  reason: Schema.NullOr(Schema.String),
  /** Capacity-lease work gates nothing (FD-IFC-081). */
  advisory: Schema.Literal(true),
});
export type LocalExecution = typeof LocalExecution.Type;

export const RehearseTool = Tool.make("rehearse", {
  description:
    "Rehearse a run against this device's working tree on the local scheduler; with wait_seconds, wait up to 600 s.",
  parameters: Schema.Struct({
    run: Schema.NonEmptyString,
    inputs: Schema.optionalKey(Schema.Unknown),
    class: Schema.optionalKey(Schema.String),
    wait_seconds: WaitSeconds,
  }),
  success: LocalExecution,
  failure: ToolError,
});

export const LeaseStatus = Schema.Struct({
  state: Schema.String,
  slots: Schema.Record(Schema.String, Schema.Number),
  remaining_token_allowance: Schema.NullOr(Schema.Number),
  offline: Schema.Boolean,
});
export type LeaseStatus = typeof LeaseStatus.Type;

export const LeaseStatusTool = Tool.make("lease_status", {
  description: "The capacity lease's state, slots, remaining token allowance and offline flag.",
  success: LeaseStatus,
  failure: ToolError,
});

/** The tools the dispatcher's `/mcp` serves: it has no device to rehearse on. */
export const DispatcherTools = Toolkit.make(
  DispatchTool,
  GetVerdictTool,
  GetFailureSummaryTool,
  CancelTool,
);

/** The union `fd mcp` serves (FD-IFC-075). */
export const ShimTools = Toolkit.make(
  RehearseTool,
  DispatchTool,
  GetVerdictTool,
  GetFailureSummaryTool,
  CancelTool,
  LeaseStatusTool,
);

/** `wait_seconds` within its tool's bound, or the `invalid_wait` tool error (FD-IFC-078). */
export const checkWait = (
  waitSeconds: number | undefined,
  max: number,
): Effect.Effect<number, ToolError> =>
  waitSeconds === undefined
    ? Effect.succeed(0)
    : Number.isInteger(waitSeconds) && waitSeconds >= 0 && waitSeconds <= max
      ? Effect.succeed(waitSeconds)
      : Effect.fail({
          error: "invalid_wait",
          message: `wait_seconds is a whole number from 0 to ${max}`,
        });

/** A result within 16 KiB serialized, or the `payload_too_large` tool error (FD-IFC-079). */
export const boundResult = <A>(result: A): Effect.Effect<A, ToolError> =>
  new TextEncoder().encode(JSON.stringify(result)).byteLength <= MAX_TOOL_RESULT_BYTES
    ? Effect.succeed(result)
    : Effect.fail({
        error: "payload_too_large",
        message: `the result exceeds ${MAX_TOOL_RESULT_BYTES} bytes`,
      });

/** A route's error as the tool error carrying its error-model code (FD-IFC-080). */
export const toToolError = (error: {
  readonly error: string;
  readonly message: string;
}): ToolError => ({
  error: error.error,
  message: error.message,
});
