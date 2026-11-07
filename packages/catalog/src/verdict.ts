// Exit to verdict (specs/runs/gate.md § Exit to verdict): every gate job's end maps to exactly one outcome, and no
// branch from a non-zero exit reaches `success` (FD-GATE-004).
import { Match } from "effect";
import type { CommandExit } from "./command.ts";
import { Outcome } from "./reasons.ts";

/** The line oxlint prints when no file matches (FD-GATE-024). */
export const NOTHING_TO_LINT_LINE = "No files found to lint";

const containsLine = (output: string, line: string) =>
  output.split(/\r?\n/).some((l) => l.trim() === line);

/** Which outcome a job command's end records (FD-GATE-002, -003, -005 to -008). */
export const verdictOf = (
  exit: CommandExit,
  options: { readonly output?: string; readonly lint?: boolean } = {},
): Outcome =>
  Match.value(exit).pipe(
    Match.tagsExhaustive({
      Exited: ({ code }) =>
        code !== 0
          ? Outcome.failure(`exit: ${code}`)
          : options.lint === true && containsLine(options.output ?? "", NOTHING_TO_LINT_LINE)
            ? Outcome.skipped("nothing-to-lint")
            : Outcome.success(),
      Signalled: ({ signal }) => Outcome.failure(`exit: signal ${signal}`),
      TimedOut: () => Outcome.failure("timeout: job"),
      DeadlineReached: () => Outcome.failure("deadline"),
      OverLimit: () => Outcome.failure("output: over limit"),
      NotStarted: () => Outcome.failure("infra: ExecFailed"),
    }),
  );

/** An install command's end: a non-zero exit is `install: exit <code>` (FD-GATE-028); any other end maps as a job's. */
export const installVerdictOf = (exit: CommandExit): Outcome =>
  Match.value(exit).pipe(
    Match.tag("Exited", ({ code }) =>
      code === 0 ? Outcome.success() : Outcome.failure(`install: exit ${code}`),
    ),
    Match.orElse((other) => verdictOf(other)),
  );
