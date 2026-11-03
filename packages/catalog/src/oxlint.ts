// The `oxlint` run's body: `npx --yes oxlint@<version>` in a checkout, with no install step (FD-GATE-022 to
// FD-GATE-024).
import { Effect } from "effect";
import type { GateExec } from "./command.ts";
import { checkedOutWorkspace, runStep, uploadLog } from "./job.ts";
import type { OxlintInput } from "./inputs.ts";
import { pullRequestSkip } from "./manifest.ts";
import type { GateArtifacts } from "./ports.ts";
import { Outcome } from "./reasons.ts";

/** The version the recipe runs where the manifest names none. */
export const OXLINT_PINNED_VERSION = "1.73.0";
export const OXLINT_TIMEOUT_SEC = 300;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/** The command the recipe runs for a version. */
export const oxlintCommand = (version: string): string => `npx --yes oxlint@${version}`;

export const runOxlint = (
  input: OxlintInput,
): Effect.Effect<Outcome, never, GateExec | GateArtifacts> =>
  Effect.gen(function* () {
    const skip = pullRequestSkip(input);
    if (skip !== undefined) return skip;
    const version = input.version ?? OXLINT_PINNED_VERSION;
    if (!VERSION.test(version)) return Outcome.failure("config: oxlint version");
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* checkedOutWorkspace(input);
        const ran = yield* runStep({
          ctx: input,
          job: "oxlint",
          command: oxlintCommand(version),
          cwd: dir,
          timeoutSec: OXLINT_TIMEOUT_SEC,
          lint: true,
        });
        yield* uploadLog("oxlint", ran.output);
        return ran.outcome;
      }),
    );
  }).pipe(
    Effect.catchTag("CheckoutFailed", () =>
      Effect.succeed(Outcome.failure("infra: CheckoutFailed")),
    ),
  );
