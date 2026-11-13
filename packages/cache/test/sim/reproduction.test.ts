// The reproduction-deadline V-SIM scenario over the seeds a pull request runs: 100 plus every kept seed of it in the
// repository's `test/sim/seeds.jsonl`. Beyond the `sim` job's pass or fail, this checks that the seeds reach every case
// the property speaks about.
import { describe, expect, it } from "vitest";
import { PR_SEEDS, readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import { simulateReproductionDeadline } from "./reproduction.sim.ts";

describe("simulation: a release awaiting its reproduction", () => {
  it("a release with no reproduction statement logged by its deadline_at concludes failure with `provenance: reproduction unavailable`", async () => {
    const messages: string[] = [];
    const reached: Record<string, number> = {};
    for (const seed of seedsOf("reproduction-deadline", PR_SEEDS, readKeptSeeds())) {
      const run = await simulateReproductionDeadline(seed);
      messages.push(...run.violations.map((v) => `seed ${seed}: ${v.message}`));
      for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
    }
    expect(messages.slice(0, 5)).toEqual([]);
    // The seeds log the statement before, at and after the deadline and never, and compare before and after it.
    for (const k of ["before", "at", "after", "never", "awaiting", "reproduced", "unavailable", "lateIgnored"])
      expect(reached[k], k).toBeGreaterThan(0);
  }, 300_000);
});
