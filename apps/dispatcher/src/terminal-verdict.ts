// The check-run conclusion for a finished execution.
//
// A `skipped` run concludes `neutral`. A run whose terminal `executions` write
// failed concludes `failure` whatever it computed: no verdict is on record, and
// a fan-out parent reading the instance status reports the same.

export type ExecutionVerdict = "success" | "failure" | "skipped";
export type CheckConclusion = "success" | "failure" | "neutral";

export const checkConclusion = (status: ExecutionVerdict, recorded: boolean): CheckConclusion =>
  !recorded ? "failure" : status === "skipped" ? "neutral" : status;
