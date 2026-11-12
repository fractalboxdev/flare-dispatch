// The scan bundle precondition over 100 seeds plus every kept seed in the repository's `test/sim/seeds.jsonl`.
import { describe, expect, it } from "vitest";
import { PR_SEEDS, readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import { simulateScanBundle } from "./scan-bundle.sim.ts";

describe("simulation: security-gate scans against a scan bundle object that is stored, deleted or unreadable", () => {
  it("[FD-GATE-102] records failure config: scan bundle missing and runs no scanner for every scan whose bundle object is absent or unreadable", async () => {
    const violations: string[] = [];
    const reached: Record<string, number> = {};
    for (const seed of seedsOf("scan-bundle", PR_SEEDS, readKeptSeeds())) {
      const run = await simulateScanBundle(seed);
      violations.push(...run.violations.map((v) => v.message));
      for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
    }
    expect(violations.slice(0, 5)).toEqual([]);
    // The seeds reach absent and unreadable objects, intact bundles that scan and other refusals.
    expect(reached.absent).toBeGreaterThan(0);
    expect(reached.unreadable).toBeGreaterThan(0);
    expect(reached.intact).toBeGreaterThan(0);
    expect(reached.refused).toBeGreaterThan(0);
  }, 120_000);

  it("replays every seed exactly", async () => {
    for (const seed of seedsOf("scan-bundle", PR_SEEDS, readKeptSeeds())) {
      const first = await simulateScanBundle(seed);
      expect((await simulateScanBundle(seed)).trace, `seed ${seed}`).toEqual(first.trace);
      expect(first.trace.length).toBeGreaterThan(0);
    }
  }, 120_000);
});
