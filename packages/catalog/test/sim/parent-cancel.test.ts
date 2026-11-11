// The job matrix's parent cancel over 100 seeds plus every kept seed in the repository's `test/sim/seeds.jsonl`.
import { describe, expect, it } from "vitest";
import { PR_SEEDS, readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import { simulateParentCancel } from "./parent-cancel.sim.ts";

describe("simulation: a job matrix's parent cancelled while its jobs are placed or running", () => {
  it("[FD-GATE-042] cancels every placed or running job through mameko's parent-ended cascade and starts no pending job", async () => {
    const violations: string[] = [];
    const reached: Record<string, number> = {};
    for (const seed of seedsOf("parent-cancel", PR_SEEDS, readKeptSeeds())) {
      const run = await simulateParentCancel(seed);
      violations.push(...run.violations.map((v) => v.message));
      for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
    }
    expect(violations.slice(0, 5)).toEqual([]);
    // The seeds reach placed and running jobs at the cancel, jobs that finished first and jobs never started.
    expect(reached.placedCancelled).toBeGreaterThan(0);
    expect(reached.runningCancelled).toBeGreaterThan(0);
    expect(reached.finishedFirst).toBeGreaterThan(0);
    expect(reached.neverStarted).toBeGreaterThan(0);
  }, 300_000);

  it("replays every seed exactly", async () => {
    for (const seed of seedsOf("parent-cancel", PR_SEEDS, readKeptSeeds())) {
      const first = await simulateParentCancel(seed);
      expect((await simulateParentCancel(seed)).trace, `seed ${seed}`).toEqual(first.trace);
      expect(first.trace.length).toBeGreaterThan(0);
    }
  }, 300_000);
});
