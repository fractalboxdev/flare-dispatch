// Tests for the admission-queue check-run line (issue #109) — pure string
// formatting, exercised with fixed inputs like failure-summary.test.ts.

import { describe, expect, it } from "vitest";
import { queuedSummary, serialQueuedSummary } from "./admission-summary";

describe("queuedSummary", () => {
  // 2026-06-05T12:34:00.000Z
  const TIMES_OUT_AT = Date.UTC(2026, 5, 5, 12, 34, 0);

  it("renders position, pool usage, and the UTC give-up time", () => {
    expect(queuedSummary(3, 16, 16, TIMES_OUT_AT)).toBe(
      "Queued — waiting for a sandbox slot behind 3 runs (16/16 in use); times out 12:34 UTC",
    );
  });

  it("singularises a one-run queue", () => {
    expect(queuedSummary(1, 16, 16, TIMES_OUT_AT)).toContain("behind 1 run (");
  });

  it("zero-pads single-digit hours and minutes", () => {
    // 2026-06-05T03:05:00.000Z
    expect(queuedSummary(0, 16, 16, Date.UTC(2026, 5, 5, 3, 5, 0))).toContain(
      "times out 03:05 UTC",
    );
  });
});

describe("serialQueuedSummary", () => {
  it("names the in-flight revision and warns that a newer dispatch replaces this one", () => {
    expect(serialQueuedSummary("0123456789abcdef0123")).toBe(
      "Queued — waiting for the in-flight run of `0123456789ab` to finish; runs of this group " +
        "never overlap. A newer dispatch replaces this one while it waits.",
    );
  });

  it("omits the revision when the holder is not known", () => {
    expect(serialQueuedSummary(undefined)).toContain("waiting for the in-flight run to finish");
  });
});
