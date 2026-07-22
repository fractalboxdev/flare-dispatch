// Tests for the failure-path presentation extraction (issue #85).
//
// `failureSummaryMd` pulls the run-authored markdown out of a run's `Exit`
// (only `AcceptanceFailed.summaryMd` carries one today); `appendFailureSummary`
// splices it under the generic "execution failed" line, bounded to GitHub's
// 65535-char check-run summary limit.

import { Cause, Exit, FiberId } from "effect";
import { describe, expect, it } from "vitest";
import {
  AcceptanceFailed,
  AdmissionTimedOut,
  ExecFailed,
  ExecTimeout,
  RunSkipped,
  SecretsMissing,
  StepFailed,
} from "@fractalboxdev/flare-dispatch-core";
import {
  CHECK_SUMMARY_MAX_CHARS,
  TRUNCATION_NOTE,
  admissionTimedOutMd,
  appendFailureSummary,
  failureSummaryMd,
  runSkippedReason,
} from "./failure-summary";

describe("failureSummaryMd", () => {
  it("extracts the markdown from a failed Exit carrying AcceptanceFailed.summaryMd", () => {
    const exit = Exit.fail(
      new AcceptanceFailed({
        exitCode: 1,
        summaryMd: "# product-demo — 0/2 chapters passed",
      }),
    );
    expect(failureSummaryMd(exit)).toBe(
      "# product-demo — 0/2 chapters passed",
    );
  });

  it("is undefined for an AcceptanceFailed without summaryMd", () => {
    expect(
      failureSummaryMd(Exit.fail(new AcceptanceFailed({ exitCode: 1 }))),
    ).toBeUndefined();
  });

  it("renders an AdmissionTimedOut as an infra-wait explanation (issue #109)", () => {
    const exit = Exit.fail(
      new AdmissionTimedOut({
        queuedForMs: 1_200_000,
        position: 3,
        poolBusy: 16,
      }),
    );
    const md = failureSummaryMd(exit);
    expect(md).toBe(
      admissionTimedOutMd(
        new AdmissionTimedOut({
          queuedForMs: 1_200_000,
          position: 3,
          poolBusy: 16,
        }),
      ),
    );
    // The summary must read as capacity back-pressure, never a test failure.
    expect(md).toContain("Timed out waiting for a sandbox slot");
    expect(md).toContain("queued for 20 min behind 3 run(s)");
    expect(md).toContain("16 sandbox slot(s) in use");
    expect(md).toContain("never started");
    expect(md).toContain("not a test failure");
  });

  it("renders ExecFailed with exit code + stderr tail", () => {
    const md = failureSummaryMd(
      Exit.fail(new ExecFailed({ exitCode: 7, stderrTail: "boom" })),
    );
    expect(md).toContain("Exec failed");
    expect(md).toContain("exit `7`");
    expect(md).toContain("boom");
  });

  it("renders ExecTimeout with the command", () => {
    const md = failureSummaryMd(
      Exit.fail(
        new ExecTimeout({ timeoutSec: 30, command: "pnpm test --watch" }),
      ),
    );
    expect(md).toContain("Exec timed out");
    expect(md).toContain("30s");
    expect(md).toContain("pnpm test --watch");
  });

  it("renders StepFailed with the step name + cause", () => {
    const md = failureSummaryMd(
      Exit.fail(
        new StepFailed({
          step: "resolve-command",
          cause: "offload-test: no command",
        }),
      ),
    );
    expect(md).toContain("Step `resolve-command` failed");
    expect(md).toContain("offload-test: no command");
  });

  it("renders SecretsMissing with the absent keys", () => {
    const md = failureSummaryMd(
      Exit.fail(new SecretsMissing({ keys: ["NPM_TOKEN", "FOO"] })),
    );
    expect(md).toContain("Missing Worker secrets");
    expect(md).toContain("`NPM_TOKEN`");
    expect(md).toContain("`FOO`");
  });

  it("is undefined for a success Exit", () => {
    expect(failureSummaryMd(Exit.succeed({ ok: true }))).toBeUndefined();
  });

  it("is undefined for a defect (Cause.die — failureOption is none)", () => {
    expect(
      failureSummaryMd(Exit.failCause(Cause.die("unexpected"))),
    ).toBeUndefined();
  });

  it("is undefined for an interrupt", () => {
    expect(
      failureSummaryMd(Exit.failCause(Cause.interrupt(FiberId.none))),
    ).toBeUndefined();
  });
});

describe("runSkippedReason", () => {
  it("extracts the reason from a RunSkipped failure (issue #21)", () => {
    const exit = Exit.fail(
      new RunSkipped({
        reason:
          "the PR diff exceeds the model's context window even after truncation, so the review could not run",
      }),
    );
    expect(runSkippedReason(exit)).toBe(
      "the PR diff exceeds the model's context window even after truncation, so the review could not run",
    );
  });

  it("is undefined for other typed run errors (they stay red)", () => {
    expect(
      runSkippedReason(
        Exit.fail(new ExecFailed({ exitCode: 7, stderrTail: "boom" })),
      ),
    ).toBeUndefined();
  });

  it("is undefined for a success Exit", () => {
    expect(runSkippedReason(Exit.succeed({ ok: true }))).toBeUndefined();
  });

  it("is undefined for a defect (Cause.die — failureOption is none)", () => {
    expect(
      runSkippedReason(Exit.failCause(Cause.die("unexpected"))),
    ).toBeUndefined();
  });

  it("is undefined for an interrupt", () => {
    expect(
      runSkippedReason(Exit.failCause(Cause.interrupt(FiberId.none))),
    ).toBeUndefined();
  });
});

describe("appendFailureSummary", () => {
  const generic = "✗ product-demo — execution failed.";

  it("returns the generic line untouched when there is no summary", () => {
    expect(appendFailureSummary(generic, undefined)).toBe(generic);
  });

  it("returns the generic line untouched for a whitespace-only summary", () => {
    expect(appendFailureSummary(generic, "  \n ")).toBe(generic);
  });

  it("appends the summary beneath the generic line, blank-line separated", () => {
    expect(appendFailureSummary(generic, "| Chapter | Result |")).toBe(
      `${generic}\n\n| Chapter | Result |`,
    );
  });

  it("truncates an oversized summary so the total stays within GitHub's limit", () => {
    const huge = "x".repeat(CHECK_SUMMARY_MAX_CHARS + 1000);
    const combined = appendFailureSummary(generic, huge);
    expect(combined.length).toBeLessThanOrEqual(CHECK_SUMMARY_MAX_CHARS);
    expect(combined.startsWith(`${generic}\n\n`)).toBe(true);
    expect(combined).toContain("summary truncated");
  });

  it("does not leave a lone high surrogate when the cut lands inside an astral char", () => {
    // Position an astral (two-UTF-16-unit) char so the truncation boundary
    // falls between its surrogate halves.
    const budget =
      CHECK_SUMMARY_MAX_CHARS -
      generic.length -
      "\n\n".length -
      TRUNCATION_NOTE.length;
    const md = "x".repeat(budget - 1) + "😀".repeat(2000);
    const combined = appendFailureSummary(generic, md);

    expect(combined.length).toBeLessThanOrEqual(CHECK_SUMMARY_MAX_CHARS);
    expect(combined.endsWith(TRUNCATION_NOTE)).toBe(true);
    // The char immediately before the truncation note must not be a lone
    // high surrogate (the split pair's first half).
    const beforeNote = combined.slice(0, combined.length - TRUNCATION_NOTE.length);
    expect(/[\uD800-\uDBFF]$/.test(beforeNote)).toBe(false);
  });

  it("keeps a within-limit summary verbatim (no truncation note)", () => {
    const md = "y".repeat(1000);
    const combined = appendFailureSummary(generic, md);
    expect(combined).toBe(`${generic}\n\n${md}`);
    expect(combined).not.toContain("summary truncated");
  });
});
