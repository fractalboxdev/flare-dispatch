// Tests for the pure per-recipe analytics aggregation (summarizeRuns) that backs
// the `/v1/analytics.json` feed — the D1 read is a thin wrapper, the grouping +
// percentile + cost-basis logic lives here and is unit-tested without a DB.

import { describe, expect, it } from "vitest";
import { summarizeRuns, type AnalyticsInputRow } from "./executions-read";

const row = (r: Partial<AnalyticsInputRow> & { run: string }): AnalyticsInputRow => ({
  status: "success",
  started_at: 0,
  completed_at: 1000,
  cost_micro_usd: null,
  cost_basis: null,
  ...r,
});

describe("summarizeRuns", () => {
  it("groups by run and computes success rate", () => {
    const out = summarizeRuns([
      row({ run: "pr-review", status: "success" }),
      row({ run: "pr-review", status: "failure" }),
      row({ run: "oxlint", status: "success" }),
    ]);
    const pr = out.find((r) => r.run === "pr-review")!;
    expect(pr.count).toBe(2);
    expect(pr.successRate).toBe(0.5);
    const ox = out.find((r) => r.run === "oxlint")!;
    expect(ox.successRate).toBe(1);
  });

  it("computes p50/p95 wall-time via nearest-rank", () => {
    const durations = [100, 200, 300, 400, 500];
    const out = summarizeRuns(
      durations.map((d) => row({ run: "x", started_at: 0, completed_at: d })),
    );
    const x = out[0]!;
    expect(x.p50DurationMs).toBe(300); // ceil(0.5*5)=3 → index 2 → 300
    expect(x.p95DurationMs).toBe(500); // ceil(0.95*5)=5 → index 4 → 500
  });

  it("averages cost only over rows that carry a rollup and picks dominant basis", () => {
    const out = summarizeRuns([
      row({ run: "pr-review", cost_micro_usd: 10_000, cost_basis: "mixed" }),
      row({ run: "pr-review", cost_micro_usd: 30_000, cost_basis: "mixed" }),
      row({ run: "pr-review", cost_micro_usd: null, cost_basis: null }), // no rollup
    ]);
    const pr = out[0]!;
    expect(pr.costSamples).toBe(2);
    expect(pr.avgCostMicroUsd).toBe(20_000);
    expect(pr.totalCostMicroUsd).toBe(40_000);
    expect(pr.basis).toBe("mixed");
  });

  it("leaves duration/cost null when there is no usable sample", () => {
    const out = summarizeRuns([
      row({ run: "x", started_at: null, completed_at: null, cost_micro_usd: null }),
    ]);
    const x = out[0]!;
    expect(x.p50DurationMs).toBeNull();
    expect(x.avgCostMicroUsd).toBeNull();
    expect(x.basis).toBeNull();
  });

  it("orders busiest recipes first", () => {
    const out = summarizeRuns([
      row({ run: "a" }),
      row({ run: "b" }),
      row({ run: "b" }),
    ]);
    expect(out.map((r) => r.run)).toEqual(["b", "a"]);
  });
});
