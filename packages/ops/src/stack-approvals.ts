// The decision store behind `POST /v1/ops/stack-approvals` (FD-IFC-104 to FD-IFC-107). The control plane implements it
// over its `stack_approvals` record; the operability group's handler checks the reason and the caller and answers the
// error model's codes.
import type { StackApprovalRecord } from "@fractalboxdev/flare-dispatch-api/declaration";
import type { ApiError } from "@fractalboxdev/flare-dispatch-api/errors";
import { Context, type Effect } from "effect";

export interface StackApprovalRequest {
  readonly executionId: string;
  readonly decision: "approve" | "reject";
  /** The operator's Access identity. */
  readonly identity: string;
  readonly reason: string;
  readonly requestId: string;
}

export class StackApprovalDecisions extends Context.Service<
  StackApprovalDecisions,
  {
    /**
     * Records the decision once: `execution_not_found` for an unknown execution, `not_awaiting_approval` for one that
     * waits for none or has ended, `conflict` once a decision is recorded.
     */
    readonly decide: (
      request: StackApprovalRequest,
    ) => Effect.Effect<StackApprovalRecord, ApiError>;
  }
>()("@fractalboxdev/flare-dispatch-ops/StackApprovalDecisions") {}
