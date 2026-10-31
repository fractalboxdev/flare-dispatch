import { describe, expect, it } from "vitest";
import type { ExecutionView } from "./client.ts";
import { exitCodeOf, verdictLines } from "./verdict.ts";

const view: ExecutionView = {
  execution_id: "01J",
  run: "check",
  class: "batch",
  status: "done",
  verdict: "failure",
  reason: "finding: test: exit 1",
  epoch: 2,
  accepted_epoch: 2,
  executor_id: "device",
  outcome_intents: 1,
};

describe("the command's verdict", () => {
  it("exits 0 only on success", () => {
    expect(exitCodeOf("success")).toBe(0);
    expect(exitCodeOf("failure")).toBe(1);
    expect(exitCodeOf("cancelled")).toBe(3);
    expect(exitCodeOf("skipped")).toBe(4);
    expect(exitCodeOf("deferred")).toBe(5);
    expect(exitCodeOf("expired")).toBe(5);
    expect(exitCodeOf(null)).toBe(5);
  });

  it("names the failing step from the record's reason", () => {
    expect(verdictLines(view)[0]).toBe("verdict: failure (finding: test: exit 1)");
  });

  it("prints a skipped verdict with its detail and a cancelled one with its cause", () => {
    expect(
      verdictLines({ ...view, verdict: "skipped", reason: "not-applicable: draft-pr" })[0],
    ).toBe("verdict: skipped (not-applicable: draft-pr)");
    expect(verdictLines({ ...view, verdict: "cancelled", reason: "superseded" })[0]).toBe(
      "verdict: cancelled (superseded)",
    );
  });
});
