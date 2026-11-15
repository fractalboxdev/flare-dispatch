// The `check.progress` scenario over 100 seeds plus every kept seed in the repository's `test/sim/seeds.jsonl`, where
// the nightly run appends each failing seed.
import { describe, expect, it } from "vitest";
import { PR_SEEDS, readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import { SCENARIO, simulateProgress } from "./check-progress.sim.ts";

describe("simulation: check.progress", () => {
  it("[FD-GH-012] for random queue positions, classes and confidentiality modes, the payload states the class, the position's bucket and deadline_at, and the check run shows the bucket exactly while FD-GH-019 does not apply", async () => {
    const violations: string[] = [];
    const reached: Record<string, number> = {};
    for (const seed of seedsOf(SCENARIO, PR_SEEDS, readKeptSeeds())) {
      const run = await simulateProgress(seed);
      violations.push(...run.violations.map((v) => v.message));
      for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
    }
    expect(violations.slice(0, 5)).toEqual([]);
    // The seeds reach every bucket, confidential-compute deliveries and executions that get no payload.
    for (const k of [
      "bucket 1",
      "bucket 2–5",
      "bucket 6–20",
      "bucket more than 20",
      "confidential",
      "no-payload",
    ])
      expect(reached[k], k).toBeGreaterThan(0);
  }, 120_000);

  it("replays a seed exactly", async () => {
    const first = await simulateProgress(7);
    expect((await simulateProgress(7)).trace).toEqual(first.trace);
  });
});
