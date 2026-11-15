import { Outcome } from "@fractalboxdev/flare-dispatch-catalog";
import { describe, expect, it } from "vitest";
import { childVerdictOf } from "./children.ts";

describe("a job's verdict from its child's terminal row", () => {
  it("[FD-GATE-041] reads the run's outcome, and no recorded verdict for a failure without a reason or a class outcome", () => {
    expect(childVerdictOf("success", null)).toEqual({
      _tag: "Recorded",
      outcome: Outcome.success(),
    });
    expect(childVerdictOf("failure", "infra: ExecFailed")).toEqual({
      _tag: "Recorded",
      outcome: Outcome.failure("infra: ExecFailed"),
    });
    expect(childVerdictOf("cancelled", "parent-ended")).toEqual({
      _tag: "Recorded",
      outcome: Outcome.cancelled("parent-ended"),
    });
    expect(childVerdictOf("skipped", "not-applicable: path-filter")).toEqual({
      _tag: "Recorded",
      outcome: Outcome.skipped("path-filter"),
    });
    for (const [status, reason] of [
      ["failure", null],
      ["deferred", null],
      ["expired", null],
    ] as const)
      expect(childVerdictOf(status, reason)).toEqual({ _tag: "NoVerdict" });
  });
});
