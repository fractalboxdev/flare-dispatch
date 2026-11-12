// The `gha` launcher's runner claims over 100 seeds plus every kept seed in the repository's `test/sim/seeds.jsonl`,
// where the nightly run appends each failing seed.
import { describe, expect, it } from "vitest";
import { PR_SEEDS, readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import { simulateClaims } from "./gha-claim.sim.ts";

describe("simulation: gha runner claims", () => {
  it("[FD-EXEC-090] across isolates, replays, re-run attempts and concurrent bursts, each (execution, epoch) admits one claim, of its own launch's run, and refuses every later one", async () => {
    const violations: string[] = [];
    const reached: Record<string, number> = {};
    for (const seed of seedsOf("gha-claim", PR_SEEDS, readKeptSeeds())) {
      const run = await simulateClaims(seed);
      violations.push(...run.violations.map((v) => v.message));
      for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
    }
    expect(violations.slice(0, 5)).toEqual([]);
    // The seeds reach accepted genuine claims, later claims after an accepted one, and concurrent bursts.
    expect(reached["accepted-genuine"]).toBeGreaterThan(0);
    expect(reached["after-accepted"]).toBeGreaterThan(0);
    expect(reached.burst).toBeGreaterThan(0);
  }, 120_000);

  it("replays a seed exactly", async () => {
    const first = await simulateClaims(5);
    expect((await simulateClaims(5)).trace).toEqual(first.trace);
  });
});
