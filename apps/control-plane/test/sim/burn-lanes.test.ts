// The burn lanes the coordinator reads over 100 seeds plus every kept seed in the repository's `test/sim/seeds.jsonl`.
import { describe, expect, it } from "vitest";
import {
  PR_SEEDS,
  readKeptSeeds,
  seedsOf,
} from "../../../../packages/ops/src/verification/harness.ts";
import { SCENARIO, simulateLanes } from "./burn-lanes.sim.ts";

describe("simulation: burn lanes", () => {
  it("[FD-PROF-058] whatever the overlay's spend values, the deployment and the leased fleet, the coordinator reads lanes of 0.41, 0.81, 2.01 and 2.82 USD per hour for batch, interactive, required and release, and admits within each", async () => {
    const violations: string[] = [];
    const reached: Record<string, number> = {};
    for (const seed of seedsOf(SCENARIO, PR_SEEDS, readKeptSeeds())) {
      const run = await simulateLanes(seed);
      violations.push(...run.violations.map((v) => `seed ${seed}: ${v.message}`));
      for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
    }
    expect(violations.slice(0, 5)).toEqual([]);
    // The seeds reach deploys at the default spend values and at overlay ones, with leased executions.
    expect(reached["defaults"]).toBeGreaterThan(0);
    expect(reached["overlay"]).toBeGreaterThan(0);
    expect(reached["leased"]).toBeGreaterThan(0);
  }, 120_000);

  it("replays a seed exactly", async () => {
    const first = await simulateLanes(7);
    expect((await simulateLanes(7)).trace).toEqual(first.trace);
  });
});
