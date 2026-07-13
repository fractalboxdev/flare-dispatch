// FlareDispatch Dispatcher — failure-path presentation (issue #85).
//
// A failed run used to post a bare "✗ <run> — execution failed." check-run
// summary, hiding the diagnosis a run may already have built (e.g.
// `product-demo`'s per-chapter table, persisted only to R2). The typed error
// channel now carries that presentation — `AcceptanceFailed.summaryMd` — and
// this module is the dispatcher half: pull the markdown out of the run's
// `Exit` and splice it under the generic line, bounded to GitHub's check-run
// summary limit. Pure + dependency-free so the workflow's failure arm stays
// unit-testable without simulating a Workflow.

import { Cause, Exit, Match, Option } from "effect";
import type { AdmissionTimedOut, RunError } from "@fractalboxdev/flare-dispatch-core";

/**
 * GitHub caps a check-run's `output.summary` at 65535 characters — a longer
 * payload 422s the whole update, which would mask the verdict itself.
 * `appendFailureSummary` truncates so the verdict always lands, however
 * chatty the run's summary was.
 */
export const CHECK_SUMMARY_MAX_CHARS = 65_535;

/** Appended when the run's markdown is cut — exported for the boundary test. */
export const TRUNCATION_NOTE =
  "\n\n_… summary truncated to fit the check-run limit._";

/**
 * Render an `AdmissionTimedOut` for the check-run summary. The run never
 * started — no container booted, no test ran — so the red check must read as
 * capacity back-pressure (infra wait), unmistakably NOT a test failure
 * (issue #109).
 */
export const admissionTimedOutMd = (e: AdmissionTimedOut): string =>
  `⏳ **Timed out waiting for a sandbox slot** — queued for ` +
  `${Math.round(e.queuedForMs / 60_000)} min behind ${e.position} run(s) ` +
  `(${e.poolBusy} sandbox slot(s) in use).\n\n` +
  `The execution **never started**: the container pool stayed saturated for ` +
  `the whole wait, so this is capacity back-pressure — **not a test ` +
  `failure**. Re-run once in-flight runs drain.`;

/**
 * Extract the run-authored failure markdown from a run's `Exit`, when one is
 * present. `undefined` on success, on a defect/interrupt (`Cause.failureOption`
 * is none — there is no typed failure to read), and on any typed failure that
 * carries no presentation. `AcceptanceFailed` carries its own
 * (run-authored) markdown; `AdmissionTimedOut` renders the infra-wait
 * explanation above; new error variants opt in by growing a branch here.
 *
 * `Cause.failureOption` picks the LEFTMOST failure, so a multi-error Cause
 * (parallel/sequential composition) surfaces at most one summary — and
 * degrades to the generic line when that leftmost failure carries none. By
 * design: a run fails with one typed error in practice.
 */
export const failureSummaryMd = (
  exit: Exit.Exit<unknown, RunError>,
): string | undefined =>
  Exit.match(exit, {
    onSuccess: () => undefined,
    onFailure: (cause) =>
      Option.match(Cause.failureOption(cause), {
        onNone: () => undefined,
        onSome: (failure) =>
          Match.value(failure).pipe(
            Match.tag("AcceptanceFailed", (e) => e.summaryMd),
            Match.tag("AdmissionTimedOut", (e) => admissionTimedOutMd(e)),
            Match.orElse(() => undefined),
          ),
      }),
  });

/**
 * Append a run's failure markdown beneath the generic failure line (blank-line
 * separated, so the markdown renders as its own block), truncating the
 * markdown — never the verdict line — to keep the combined summary within
 * `CHECK_SUMMARY_MAX_CHARS`.
 */
export const appendFailureSummary = (
  genericLine: string,
  summaryMd: string | undefined,
): string => {
  if (summaryMd === undefined || summaryMd.trim() === "") return genericLine;
  const combined = `${genericLine}\n\n${summaryMd}`;
  if (combined.length <= CHECK_SUMMARY_MAX_CHARS) return combined;
  const budget =
    CHECK_SUMMARY_MAX_CHARS -
    genericLine.length -
    "\n\n".length -
    TRUNCATION_NOTE.length;
  // A generic line that alone exhausts the limit cannot happen today (it is a
  // single sentence), but guard anyway: drop the summary rather than the line.
  if (budget <= 0) return genericLine.slice(0, CHECK_SUMMARY_MAX_CHARS);
  // `slice` counts UTF-16 units, so the cut can land inside a surrogate pair —
  // strip a trailing lone high surrogate so the checks payload stays
  // well-formed (a mangled pair can 422 the whole update).
  const truncated = summaryMd
    .slice(0, budget)
    .replace(/[\uD800-\uDBFF]$/, "");
  return `${genericLine}\n\n${truncated}${TRUNCATION_NOTE}`;
};
