// The `check` run's body: one commit in a clean workspace, then each step in order until one fails
// (FD-GATE-019 to FD-GATE-021).
import { Effect } from "effect";
import type { GateExec } from "./command.ts";
import { checkedOutWorkspace, runStep, uploadLog } from "./job.ts";
import { isKey, pullRequestSkip, timeoutProblem } from "./manifest.ts";
import type { GateArtifacts } from "./ports.ts";
import { isSuccess, Outcome } from "./reasons.ts";
import { CHECK_MAX_DURATION_SEC, DEFAULT_STEP_TIMEOUT_SEC, type CheckInput } from "./spec.ts";

/** The first configuration problem of a `check` input, before any command runs. */
const configProblem = (input: CheckInput): Outcome | undefined => {
  if (input.label !== undefined && !isKey(input.label)) return Outcome.failure("config: label");
  for (const step of input.steps) {
    if (!isKey(step.label)) return Outcome.failure("config: label");
    const bad = timeoutProblem(step.timeoutSec, CHECK_MAX_DURATION_SEC);
    if (bad !== undefined) return bad;
  }
  return undefined;
};

export const runCheck = (
  input: CheckInput,
): Effect.Effect<Outcome, never, GateExec | GateArtifacts> =>
  Effect.gen(function* () {
    const early = pullRequestSkip(input) ?? configProblem(input);
    if (early !== undefined) return early;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* checkedOutWorkspace(input);
        for (const step of input.steps) {
          const ran = yield* runStep({
            ctx: input,
            job: step.label,
            command: step.command,
            cwd: dir,
            timeoutSec: step.timeoutSec ?? DEFAULT_STEP_TIMEOUT_SEC,
          });
          yield* uploadLog(step.label, ran.output);
          if (!isSuccess(ran.outcome)) return ran.outcome;
        }
        return Outcome.success();
      }),
    );
  }).pipe(
    Effect.catchTag("CheckoutFailed", () =>
      Effect.succeed(Outcome.failure("infra: CheckoutFailed")),
    ),
  );
