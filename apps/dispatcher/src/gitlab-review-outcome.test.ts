// Unit tests for the GitLab review outcome mapping (the pure piece of
// GitlabReviewWorkflow's review step).

import { afterEach, describe, expect, it, vi } from "vitest";
import { Cause, Exit } from "effect";
import type { MrComputeResult } from "@fractalboxdev/flare-dispatch-runs/mr-review";
import {
  estimateInfraUsd,
  placeholderNoteBody,
  reconcilePostedStatus,
  reviewOutcome,
  reviewStepFailedOutcome,
  skippedQuotaNoteBody,
  withTimingFooter,
  type ReviewOutcome,
} from "./gitlab-review-outcome";

const output = {
  verdict: "comment" as const,
  tier: "lite" as const,
  critical: 0,
  warnings: 1,
  suggestions: 0,
  findings: [],
};

afterEach(() => vi.restoreAllMocks());

const usage = { inputTokens: 14230, outputTokens: 1872, calls: 5 };

describe("reviewOutcome", () => {
  it("success (output present) → status success + summaryJson (output + usage) + the note body", () => {
    const compute: MrComputeResult = { status: "success", output, usage, noteBody: "the note", reason: null };
    const out = reviewOutcome(Exit.succeed(compute));
    expect(out.status).toBe("success");
    expect(out.noteBody).toBe("the note");
    expect(out.reason).toBeNull();
    // usage.calls flows through to the outcome's own `calls` field.
    expect(out.calls).toBe(5);
    // summary_json carries the review output AND the aggregated token usage.
    expect(JSON.parse(out.summaryJson!)).toEqual({ ...output, usage });
  });

  it("usage without a calls field (a value built before it existed) → calls defaults to 0", () => {
    const compute: MrComputeResult = { status: "success", output, usage: { inputTokens: 1, outputTokens: 1 }, noteBody: "the note", reason: null };
    const out = reviewOutcome(Exit.succeed(compute));
    expect(out.calls).toBe(0);
  });

  it("compute-level failure (output null) → status failure, summaryJson null, failure note + reason", () => {
    const compute: MrComputeResult = {
      status: "failure",
      output: null,
      usage: null,
      noteBody: "could not complete",
      reason: "backend \"workers-ai\" is misconfigured — set pr-review.workers-ai.model",
    };
    const out = reviewOutcome(Exit.succeed(compute));
    expect(out.status).toBe("failure");
    expect(out.summaryJson).toBeNull();
    expect(out.noteBody).toBe("could not complete");
    expect(out.reason).toBe("backend \"workers-ai\" is misconfigured — set pr-review.workers-ai.model");
  });

  it("skipped-quota (null note) → status skipped-quota, summaryJson null, posts NOTHING", () => {
    const compute: MrComputeResult = {
      status: "skipped-quota",
      output: null,
      usage: null,
      noteBody: null,
      reason: "model quota exhausted (rate-limited)",
    };
    const out = reviewOutcome(Exit.succeed(compute));
    expect(out.status).toBe("skipped-quota");
    expect(out.summaryJson).toBeNull();
    expect(out.noteBody).toBeNull();
    expect(out.reason).toBe("model quota exhausted (rate-limited)");
  });

  it("degraded run (output null) WITH billed tokens → summaryJson carries a usage-only summary", () => {
    // A rate limit or failure after some seats answered has billed tokens — the
    // D1 row must record real spend, not report nothing.
    const compute: MrComputeResult = {
      status: "skipped-quota",
      output: null,
      usage: { inputTokens: 300, outputTokens: 60 },
      noteBody: null,
      reason: "model quota exhausted (rate-limited)",
    };
    const out = reviewOutcome(Exit.succeed(compute));
    expect(out.status).toBe("skipped-quota");
    expect(out.noteBody).toBeNull();
    expect(JSON.parse(out.summaryJson!)).toEqual({ usage: { inputTokens: 300, outputTokens: 60 } });
  });

  it("review step failed (retries exhausted, timeout) → after 2 attempts, timeout wording, error summary", () => {
    const out = reviewStepFailedOutcome("Execution timed out after 600000ms <x>");
    expect(out.status).toBe("failure");
    expect(JSON.parse(out.summaryJson!)).toEqual({ error: "review step failed: Execution timed out after 600000ms x" });
    expect(out.noteBody).toContain("could not complete");
    expect(out.noteBody).toContain("after 2 attempts");
    expect(out.noteBody).toContain("review step timed out after 25 minutes each");
    expect(out.noteBody).toContain("<!-- flare-dispatch: mr-review -->");
    expect(out.reason).toBe("review step timed out after 25 minutes each");
    expect(out.calls).toBe(0);
  });

  it("review step failed (a non-timeout error) → after 2 attempts, the actual reason verbatim", () => {
    const out = reviewStepFailedOutcome("platform error: workerd crashed");
    expect(out.noteBody).toContain("after 2 attempts");
    expect(out.noteBody).toContain("(platform error: workerd crashed)");
    expect(out.reason).toBe("platform error: workerd crashed");
  });

  it("a DEFECT is logged (Cause.pretty) and yields a crash note + reason", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = reviewOutcome(Exit.failCause(Cause.die(new Error("boom"))) as Exit.Exit<MrComputeResult, never>);
    expect(out.status).toBe("failure");
    expect(out.summaryJson).toBeNull();
    expect(out.noteBody).toContain("mr-review crashed");
    expect(out.noteBody).toContain("<!-- flare-dispatch: mr-review -->");
    expect(out.reason).toBe("review crashed — see the dispatcher logs");
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]![0])).toContain("boom");
  });
});

describe("placeholderNoteBody", () => {
  it("renders the short provisional note with the head sha12, an HH:MM UTC timestamp, and the marker", () => {
    // 2026-09-14T03:07:00Z
    const postedAtMs = Date.UTC(2026, 8, 14, 3, 7, 0);
    const body = placeholderNoteBody({ headSha: "abcdef0123456789", postedAtMs });
    expect(body).toContain("flare-dispatch review started");
    expect(body).toContain("`abcdef012345`");
    expect(body).toContain("03:07 UTC");
    expect(body).toContain("results replace this note");
    expect(body).toContain("<!-- flare-dispatch: mr-review -->");
  });

  it("truncates the head sha to 12 chars even when given the full 40-char sha", () => {
    const body = placeholderNoteBody({ headSha: "0123456789abcdef0123456789abcdef01234567", postedAtMs: Date.now() });
    expect(body).toContain("`0123456789ab`");
    expect(body).not.toContain("0123456789abcdef");
  });
});

describe("skippedQuotaNoteBody", () => {
  it("renders a short, honest degraded status carrying the marker", () => {
    const body = skippedQuotaNoteBody();
    expect(body).toContain("review skipped");
    expect(body).toContain("model quota exhausted");
    expect(body).toContain("request-ai-review");
    expect(body).toContain("<!-- flare-dispatch: mr-review -->");
  });
});

describe("estimateInfraUsd", () => {
  it("prices requests ($0.30/M) + CPU time ($0.02/M CPU-ms, 20ms/call + 5ms/step)", () => {
    // 10 model calls + 5 steps: requests = 15; CPU-ms = 10*20 + 5*5 = 225.
    // requestsUsd = 15/1e6 * 0.3 = 0.0000045; cpuUsd = 225/1e6 * 0.02 = 0.0000045.
    const usd = estimateInfraUsd({ modelCalls: 10, steps: 5, elapsedMs: 60_000 });
    expect(usd).toBeCloseTo(0.000009, 9);
  });

  it("is zero for zero calls and zero steps regardless of elapsed time", () => {
    expect(estimateInfraUsd({ modelCalls: 0, steps: 0, elapsedMs: 999_999 })).toBe(0);
  });

  it("does not vary with elapsedMs (CPU-ms billing is active time, not wall time)", () => {
    const short = estimateInfraUsd({ modelCalls: 4, steps: 5, elapsedMs: 1_000 });
    const long = estimateInfraUsd({ modelCalls: 4, steps: 5, elapsedMs: 25 * 60_000 });
    expect(short).toBe(long);
  });

  it("scales linearly with model calls and steps", () => {
    const one = estimateInfraUsd({ modelCalls: 1, steps: 0, elapsedMs: 0 });
    const ten = estimateInfraUsd({ modelCalls: 10, steps: 0, elapsedMs: 0 });
    expect(ten).toBeCloseTo(one * 10, 12);
  });
});

describe("withTimingFooter", () => {
  const body = ["some note text", "", "<!-- flare-dispatch: mr-review -->"].join("\n");

  it("renders <m>m <s>s wall time · <N> model calls · Workers/Workflows <usd> (est.), inserted before the marker", () => {
    // 90_000ms = 1m 30s.
    const out = withTimingFooter(body, { elapsedMs: 90_000, modelCalls: 6, steps: 5 });
    expect(out).toContain("⏱ 1m 30s wall time · 6 model calls · Workers/Workflows ");
    expect(out).toContain("(est.)");
    const footerIdx = out.indexOf("⏱");
    const markerIdx = out.indexOf("<!-- flare-dispatch: mr-review -->");
    expect(footerIdx).toBeGreaterThan(-1);
    expect(footerIdx).toBeLessThan(markerIdx);
  });

  it("the dollar figure matches estimateInfraUsd for the same inputs", () => {
    const info = { elapsedMs: 45_000, modelCalls: 3, steps: 6 };
    const out = withTimingFooter(body, info);
    const usd = estimateInfraUsd(info);
    expect(out).toContain(usd < 0.001 ? "< $0.001 (est.)" : `≈$${usd.toFixed(4)} (est.)`);
  });

  it("floors sub-minute seconds correctly (0m <s>s for under a minute)", () => {
    const out = withTimingFooter(body, { elapsedMs: 7_400, modelCalls: 1, steps: 1 });
    expect(out).toContain("⏱ 0m 7s wall time");
  });

  it("appends the line at the end when the marker is absent (never silently drops it)", () => {
    const out = withTimingFooter("no marker here", { elapsedMs: 1_000, modelCalls: 1, steps: 1 });
    expect(out).toContain("no marker here");
    expect(out).toContain("⏱ 0m 1s wall time");
  });

  it("clamps a negative elapsedMs to 0m 0s rather than rendering a negative duration", () => {
    const out = withTimingFooter(body, { elapsedMs: -500, modelCalls: 1, steps: 1 });
    expect(out).toContain("⏱ 0m 0s wall time");
  });

  it("renders 'unknown model calls' instead of asserting a lost count is zero", () => {
    const out = withTimingFooter(body, { elapsedMs: 90_000, modelCalls: "unknown", steps: 5 });
    expect(out).toContain("⏱ 1m 30s wall time · unknown model calls · Workers/Workflows ");
    expect(out).not.toContain("0 model calls");
  });

  it("the dollar estimate for 'unknown' model calls matches treating it as zero calls", () => {
    const info = { elapsedMs: 45_000, steps: 6 };
    const out = withTimingFooter(body, { ...info, modelCalls: "unknown" });
    const usd = estimateInfraUsd({ ...info, modelCalls: 0 });
    expect(out).toContain(usd < 0.001 ? "< $0.001 (est.)" : `≈$${usd.toFixed(4)} (est.)`);
  });

  it("inserts before the LAST marker occurrence, not the first", () => {
    const twoMarkers = [
      "<!-- flare-dispatch: mr-review -->",
      "some quoted text repeating the marker verbatim",
      "<!-- flare-dispatch: mr-review -->",
    ].join("\n");
    const out = withTimingFooter(twoMarkers, { elapsedMs: 1_000, modelCalls: 1, steps: 1 });
    const firstMarkerIdx = out.indexOf("<!-- flare-dispatch: mr-review -->");
    const footerIdx = out.indexOf("⏱");
    const lastMarkerIdx = out.lastIndexOf("<!-- flare-dispatch: mr-review -->");
    // The footer sits between the two markers: after the first (left alone)
    // and immediately before the last.
    expect(footerIdx).toBeGreaterThan(firstMarkerIdx);
    expect(footerIdx).toBeLessThan(lastMarkerIdx);
  });
});

describe("reconcilePostedStatus", () => {
  const success = (noteBody: string | null): ReviewOutcome => ({
    status: "success",
    summaryJson: null,
    noteBody,
    reason: null,
    calls: 2,
  });

  it("success with a note that failed to post → downgraded to failure, reason recorded", () => {
    const out = reconcilePostedStatus(success("some review body"), false);
    expect(out).toEqual({ status: "failure", summaryExtra: { error: "note not posted" } });
  });

  it("success with a note that DID post → unchanged", () => {
    const out = reconcilePostedStatus(success("some review body"), true);
    expect(out).toEqual({ status: "success", summaryExtra: null });
  });

  it("skipped-quota (null noteBody by design) → unchanged even though posted is false", () => {
    const outcome: ReviewOutcome = {
      status: "skipped-quota",
      summaryJson: null,
      noteBody: null,
      reason: "quota exhausted",
      calls: 0,
    };
    const out = reconcilePostedStatus(outcome, false);
    expect(out).toEqual({ status: "skipped-quota", summaryExtra: null });
  });

  it("a success outcome with no note body (edge case) is left alone regardless of posted", () => {
    const out = reconcilePostedStatus(success(null), false);
    expect(out).toEqual({ status: "success", summaryExtra: null });
  });

  it("an already-failure outcome is left alone", () => {
    const outcome: ReviewOutcome = {
      status: "failure",
      summaryJson: null,
      noteBody: "could not complete",
      reason: "boom",
      calls: 0,
    };
    const out = reconcilePostedStatus(outcome, false);
    expect(out).toEqual({ status: "failure", summaryExtra: null });
  });
});
