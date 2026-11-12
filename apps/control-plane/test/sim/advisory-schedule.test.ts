// Security-gate scans against the tick's daily refresh schedule over 100 seeds plus every kept seed in the
// repository's `test/sim/seeds.jsonl`.
import { describe, expect, it } from "vitest";
import {
  PR_SEEDS,
  readKeptSeeds,
  seedsOf,
} from "../../../../packages/ops/src/verification/harness.ts";
import { simulateAdvisorySchedule } from "./advisory-schedule.sim.ts";

describe("simulation: security-gate scans against the tick's daily advisory-refresh schedule", () => {
  it("[FD-GATE-107] records no config: advisory snapshot stale <ecosystem> under the default scan.advisoryMaxAgeHours while every daily refresh succeeds", async () => {
    const violations: string[] = [];
    const reached: Record<string, number> = {};
    for (const seed of seedsOf("advisory-schedule", PR_SEEDS, readKeptSeeds())) {
      const run = await simulateAdvisorySchedule(seed);
      violations.push(...run.violations.map((v) => v.message));
      for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
    }
    expect(violations.slice(0, 5)).toEqual([]);
    // The seeds reach scans whose snapshot is more than 24 h old by its Last-Modified time, as well as younger ones.
    expect(reached["older-than-24h"]).toBeGreaterThan(0);
    expect(reached["within-24h"]).toBeGreaterThan(0);
    expect(reached.refreshed).toBeGreaterThan(0);
  }, 240_000);

  it("replays every seed exactly", async () => {
    for (const seed of seedsOf("advisory-schedule", 10, readKeptSeeds())) {
      const first = await simulateAdvisorySchedule(seed);
      expect((await simulateAdvisorySchedule(seed)).trace, `seed ${seed}`).toEqual(first.trace);
      expect(first.trace.length).toBeGreaterThan(0);
    }
  }, 240_000);
});
