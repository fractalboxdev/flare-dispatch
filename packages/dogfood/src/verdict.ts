// From the coordinator's record to the command's report and exit code.
import { Match } from "effect";
import type { ExecutionView } from "./client.ts";

/** The exit codes of specs/interfaces.md § `fd` commands. */
export const EXIT_FAILURE = 1;
export const EXIT_CANCELLED = 3;
export const EXIT_SKIPPED = 4;
export const EXIT_NO_VERDICT = 5;

export const exitCodeOf = (verdict: string | null): number =>
  Match.value(verdict).pipe(
    Match.when("success", () => 0),
    Match.when("failure", () => EXIT_FAILURE),
    Match.when("cancelled", () => EXIT_CANCELLED),
    Match.when("skipped", () => EXIT_SKIPPED),
    Match.orElse(() => EXIT_NO_VERDICT),
  );

/** The lines that report one finished execution; every value comes from the control plane's record. */
export const verdictLines = (view: ExecutionView): readonly string[] => [
  `verdict: ${view.verdict ?? "none"}${view.reason === null ? "" : ` (${view.reason})`}`,
  `record: execution ${view.execution_id}, run ${view.run}, class ${view.class}, executor ${view.executor_id ?? "none"}, epoch ${view.epoch ?? "none"}, accepted epoch ${view.accepted_epoch ?? "none"}`,
  `github: output skipped, the control plane has no credentials; ${view.outcome_intents} outcome intent stays in the outbox`,
];
