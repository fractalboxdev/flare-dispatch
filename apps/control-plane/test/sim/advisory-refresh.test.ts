// The advisory refresh under failing refreshes over 100 seeds plus every kept seed in the repository's
// `test/sim/seeds.jsonl`.
import { describe, expect, it } from "vitest";
import {
  PR_SEEDS,
  readKeptSeeds,
  seedsOf,
} from "../../../../packages/ops/src/verification/harness.ts";
import { simulateAdvisoryRefresh } from "./advisory-refresh.sim.ts";

describe("simulation: the tick's advisory-refresh step over days of failing and succeeding refreshes", () => {
  it("[FD-OPS-102] keeps every ecosystem's recorded snapshot unchanged through each refresh of it that fails", async () => {
    const violations: string[] = [];
    const reached: Record<string, number> = {};
    for (const seed of seedsOf("advisory-refresh", PR_SEEDS, readKeptSeeds())) {
      const run = await simulateAdvisoryRefresh(seed);
      violations.push(...run.violations.map((v) => v.message));
      for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
    }
    expect(violations.slice(0, 5)).toEqual([]);
    // The seeds reach failures over a recorded snapshot, failures before any, and refreshes that record.
    expect(reached["failed-kept"]).toBeGreaterThan(0);
    expect(reached["failed-none"]).toBeGreaterThan(0);
    expect(reached.refreshed).toBeGreaterThan(0);
  }, 120_000);

  it("replays every seed exactly", async () => {
    for (const seed of seedsOf("advisory-refresh", 20, readKeptSeeds())) {
      const first = await simulateAdvisoryRefresh(seed);
      expect((await simulateAdvisoryRefresh(seed)).trace, `seed ${seed}`).toEqual(first.trace);
      expect(first.trace.length).toBeGreaterThan(0);
    }
  }, 120_000);
});
