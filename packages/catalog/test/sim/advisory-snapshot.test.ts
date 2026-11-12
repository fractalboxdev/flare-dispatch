// The advisory snapshot age precondition over 100 seeds plus every kept seed in the repository's
// `test/sim/seeds.jsonl`.
import { describe, expect, it } from "vitest";
import { PR_SEEDS, readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import { simulateAdvisorySnapshot } from "./advisory-snapshot.sim.ts";

describe("simulation: security-gate scans over advisory snapshots aging on a virtual clock", () => {
  it("[FD-GATE-107] records failure config: advisory snapshot stale <ecosystem> and runs no scanner for every scan whose changed ecosystem's snapshot is older than scan.advisoryMaxAgeHours at the scan's time", async () => {
    const violations: string[] = [];
    const reached: Record<string, number> = {};
    for (const seed of seedsOf("advisory-snapshot", PR_SEEDS, readKeptSeeds())) {
      const run = await simulateAdvisorySnapshot(seed);
      violations.push(...run.violations.map((v) => v.message));
      for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
    }
    expect(violations.slice(0, 5)).toEqual([]);
    // The seeds reach stale snapshots, missing ones and scans whose every snapshot is fresh.
    expect(reached.stale).toBeGreaterThan(0);
    expect(reached.missing).toBeGreaterThan(0);
    expect(reached.fresh).toBeGreaterThan(0);
  }, 120_000);

  it("replays every seed exactly", async () => {
    for (const seed of seedsOf("advisory-snapshot", PR_SEEDS, readKeptSeeds())) {
      const first = await simulateAdvisorySnapshot(seed);
      expect((await simulateAdvisorySnapshot(seed)).trace, `seed ${seed}`).toEqual(first.trace);
      expect(first.trace.length).toBeGreaterThan(0);
    }
  }, 120_000);
});
