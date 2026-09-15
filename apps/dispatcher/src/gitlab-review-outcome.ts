// FlareDispatch Dispatcher — GitLab review outcome mapping.
//
// The PURE piece of `GitlabReviewWorkflow`'s review step, split out so it is
// unit-testable in plain Node (workflow-gitlab.ts imports `cloudflare:workers`,
// which a Node test can't resolve). Maps the `Exit` of `mrReviewCompute` onto the
// terminal `executions`-row fields + the note body to post — and, crucially,
// LOGS the full `Cause` (via `Cause.pretty`) on a failure/defect so a crashed
// review surfaces in `wrangler tail` instead of being silently swallowed.

import { Cause, Exit } from "effect";
import type { MrComputeResult } from "@fractalboxdev/flare-dispatch-runs/mr-review";
import { formatUsd } from "@fractalboxdev/flare-dispatch-runs/mr-review-cost";
import { REVIEW_STEP_ATTEMPTS, REVIEW_STEP_TIMEOUT } from "./gitlab-review-step-config";

/** The `<!-- flare-dispatch: mr-review -->` marker — kept in one place. */
const MR_REVIEW_MARKER = "<!-- flare-dispatch: mr-review -->";

/** Whether a usage figure reflects tokens actually billed (non-null, non-zero). */
const hasSpend = (usage: MrComputeResult["usage"]): boolean =>
  usage !== null && (usage.inputTokens > 0 || usage.outputTokens > 0);

/** What the review step yields for `finalize` + the `post-review` step. */
export type ReviewOutcome = {
  /** Terminal `executions.status`. `skipped-quota` = model quota exhausted, no
   *  note posted (graceful degradation). */
  readonly status: "success" | "failure" | "skipped-quota";
  /** `executions.summary_json` — the review output PLUS aggregated token usage;
   *  usage-only when the review degraded after billing tokens; `null` when nothing
   *  was billed. */
  readonly summaryJson: string | null;
  /** The note body the `post-review` step posts — `null` means post NOTHING
   *  (skipped-quota). */
  readonly noteBody: string | null;
  /** Plain-text reason for a non-`success` status — the Slack failure
   *  notification uses it directly (the note body renders the same substance
   *  with markdown decoration). `null` on success. */
  readonly reason: string | null;
  /** How many model calls the metering gateway counted (`usage.calls`, 0 when
   *  the review never reached a model, e.g. an unconfigured backend, or a
   *  retry-exhausted step whose usage never made it out). Feeds the timing/
   *  infra-cost footer and persists into `summary_json` at `finalize`. */
  readonly calls: number;
};

/**
 * The provisional note `post-placeholder` posts right after `insert-execution`
 * — `post-review` replaces it in place once the review finishes (or on a
 * failure — see gitlab-slack-notify.ts / workflow-gitlab.ts's post-review
 * step). Carries the SAME marker as the finished note so it is recognisable as
 * a flare-dispatch comment even if a Workflow crashes before `post-review` runs.
 */
export const placeholderNoteBody = (info: {
  readonly headSha: string;
  readonly postedAtMs: number;
}): string => {
  const sha12 = info.headSha.slice(0, 12);
  const hhmm = new Date(info.postedAtMs).toISOString().slice(11, 16);
  return [
    `🔎 **flare-dispatch review started** · head \`${sha12}\` · ${hhmm} UTC · results replace this note`,
    "",
    MR_REVIEW_MARKER,
  ].join("\n");
};

/**
 * What `post-review` posts (replacing the placeholder) when the outcome is
 * `skipped-quota` — `ReviewOutcome.noteBody` is `null` there by design
 * (nothing was rendered to post), which used to mean `post-review` posted
 * NOTHING and left the "review started … results replace this note"
 * placeholder standing forever. This gives the MR a short, honest terminal
 * status instead, so no run ends on stale placeholder text. Carries the SAME
 * marker as every other rendered note body.
 */
export const skippedQuotaNoteBody = (): string =>
  `⏸ review skipped: model quota exhausted; nothing was posted by the reviewer. Re-run with the request-ai-review label later.\n\n${MR_REVIEW_MARKER}`;

/**
 * Estimate the Workers/Workflows infra cost of one review — PURE, no
 * bindings, so the dollar figure is unit-testable. Workers Paid list prices,
 * read 2026-09-14:
 *
 *   requests: $0.30 per million — one per model call, one per Workflow step.
 *   CPU time: $0.02 per million CPU-ms — budgeted at 20 CPU-ms per model call
 *     (the fan-out's request/response + JSON-schema work around each call) and
 *     5 CPU-ms per Workflow step (each step is mostly an I/O wait on D1/KV/
 *     the GitLab API, which is NOT billed CPU time; 5ms covers the actual
 *     compute around it).
 *
 * `elapsedMs` (wall-clock time) is part of the input shape — the SAME object
 * also drives the footer's "wall time" text (see {@link withTimingFooter}) —
 * but does NOT enter this formula: CPU-ms billing is active-compute time, and
 * wall time includes idle waits (model latency, the review step's 30s retry
 * delay) that a CPU-ms estimate must not charge for.
 */
export const estimateInfraUsd = (info: {
  readonly modelCalls: number;
  readonly steps: number;
  readonly elapsedMs: number;
}): number => {
  const requests = info.modelCalls + info.steps;
  const cpuMs = info.modelCalls * 20 + info.steps * 5;
  const requestsUsd = (requests / 1_000_000) * 0.3;
  const cpuUsd = (cpuMs / 1_000_000) * 0.02;
  return requestsUsd + cpuUsd;
};

/**
 * Render the "⏱ <m>m <s>s wall time · <N|unknown> model calls · Workers/
 * Workflows est. $<x>" line and insert it just above the LAST occurrence of
 * the `<!-- flare-dispatch: mr-review -->` marker (appended at the end when
 * the marker is absent) — PURE, unit-tested directly. `info.elapsedMs` also
 * feeds {@link estimateInfraUsd} so the wall time shown and the dollar
 * estimate always come from the same number.
 */
export const withTimingFooter = (
  body: string,
  info: {
    readonly elapsedMs: number;
    /**
     * `"unknown"` renders "unknown model calls" instead of a number — for a
     * review-STEP failure (retries exhausted), `calls: 0` on the outcome is a
     * LOST count (the usage Ref lived inside the crashed/timed-out attempt),
     * not a true zero, and the footer must not assert one.
     */
    readonly modelCalls: number | "unknown";
    readonly steps: number;
  },
): string => {
  const totalSec = Math.max(0, Math.round(info.elapsedMs / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const countedCalls = info.modelCalls === "unknown" ? 0 : info.modelCalls;
  const usd = estimateInfraUsd({ modelCalls: countedCalls, steps: info.steps, elapsedMs: info.elapsedMs });
  const callsText = info.modelCalls === "unknown" ? "unknown" : `${info.modelCalls}`;
  const line = `⏱ ${m}m ${s}s wall time · ${callsText} model calls · Workers/Workflows ${formatUsd(usd)} (est.)`;
  const markerIdx = body.lastIndexOf(MR_REVIEW_MARKER);
  return markerIdx === -1
    ? `${body}\n\n${line}`
    : `${body.slice(0, markerIdx)}${line}\n\n${body.slice(markerIdx)}`;
};

/** Whether a review-step failure message describes the step's own timeout
 *  (as opposed to some other thrown error) — used to render the friendlier,
 *  fixed wording instead of echoing CF's raw timeout message. */
const isTimeoutMessage = (message: string): boolean => /time(d)?\s*out/i.test(message);

/**
 * The outcome when the review STEP itself failed — retries exhausted, typically the
 * Workflow step timeout on a large fan-out. Without it the Workflow errors, the D1 row
 * stays `running` forever and the MR gets no note: a silent failure.
 */
export const reviewStepFailedOutcome = (message: string): ReviewOutcome => {
  const reason = message.replace(/[<>[\]]/g, "").slice(0, 200);
  const humanReason = isTimeoutMessage(reason)
    ? `review step timed out after ${REVIEW_STEP_TIMEOUT} each`
    : reason;
  return {
    status: "failure",
    summaryJson: JSON.stringify({ error: `review step failed: ${reason}` }),
    noteBody: `⚠️ **mr-review could not complete** after ${REVIEW_STEP_ATTEMPTS} attempts (${humanReason}).\n\n${MR_REVIEW_MARKER}`,
    reason: humanReason,
    // A retry-exhausted step's usage Ref lives inside the crashed/timed-out
    // attempt and is lost with it — nothing billed made it out. (The note's
    // OWN timing footer renders "unknown", not 0 — see withTimingFooter.)
    calls: 0,
  };
};

/**
 * Map the `mrReviewCompute` Exit onto a {@link ReviewOutcome}. `mrReviewCompute`
 * is designed never to fail (it catches its own errors into a failure note), so
 * the success arm is the normal path; the failure arm is a DEFECT safety net
 * that logs the Cause and posts a generic crash note.
 */
export const reviewOutcome = (
  exit: Exit.Exit<MrComputeResult, never>,
): ReviewOutcome =>
  Exit.match(exit, {
    onSuccess: (r) => ({
      status: r.status,
      // Persist the review output AND the aggregated token usage into
      // summary_json so the D1 row carries the per-run cost inputs.
      // A degraded run (failure / skipped-quota) can still have billed tokens on the
      // seats that did answer; the D1 row must record that spend, not report nothing.
      summaryJson:
        r.output !== null
          ? JSON.stringify({ ...r.output, usage: r.usage })
          : hasSpend(r.usage)
            ? JSON.stringify({ usage: r.usage })
            : null,
      noteBody: r.noteBody,
      reason: r.reason,
      calls: r.usage?.calls ?? 0,
    }),
    onFailure: (cause) => {
      // A DEFECT inside the review (not a handled error) — log the full cause so
      // it reaches `wrangler tail`, then still post a note so the MR author sees
      // the review did not silently vanish.
      console.error(`[gitlab-review] review crashed:\n${Cause.pretty(cause)}`);
      return {
        status: "failure" as const,
        summaryJson: null,
        noteBody: `⚠️ **mr-review crashed** — see the dispatcher logs.\n\n${MR_REVIEW_MARKER}`,
        reason: "review crashed — see the dispatcher logs",
        calls: 0,
      };
    },
  });

/**
 * The `finalize` step's terminal status + the `summary_json` fields it should
 * merge in — reconciled against whether `post-review` actually got the note
 * out. A `success` outcome that HAD a note to post (`noteBody !== null`) but
 * failed to post it must not leave the D1 row claiming success: nobody saw
 * the result. `skipped-quota`'s `noteBody === null` means nothing was ever
 * meant to post (graceful degradation, not a posting failure) — left
 * untouched, as is any outcome that already isn't `success`, and any
 * `success` whose note WAS posted. PURE — exported for direct unit testing.
 */
export const reconcilePostedStatus = (
  outcome: ReviewOutcome,
  posted: boolean,
): { readonly status: ReviewOutcome["status"]; readonly summaryExtra: Record<string, unknown> | null } =>
  outcome.status === "success" && outcome.noteBody !== null && !posted
    ? { status: "failure", summaryExtra: { error: "note not posted" } }
    : { status: outcome.status, summaryExtra: null };
