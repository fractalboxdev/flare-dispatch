// The decision store behind `POST /v1/ops/stack-approvals` lives with the API's other ports, so the control plane's
// Worker modules implement it without importing this package.
export {
  StackApprovalDecisions,
  type StackApprovalRequest,
} from "@fractalboxdev/flare-dispatch-api/ports";
