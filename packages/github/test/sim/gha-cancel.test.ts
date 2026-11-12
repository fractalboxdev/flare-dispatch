// The `gha` launcher's cancels over 100 seeds plus every kept seed in the repository's `test/sim/seeds.jsonl`, where
// the nightly run appends each failing seed.
import { describe, expect, it } from "vitest";
import { PR_SEEDS, readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import { simulateCancels } from "./gha-cancel.sim.ts";

describe("simulation: gha launcher cancels", () => {
  it("[FD-EXEC-092] with starts, re-dispatches and cancels interleaved across isolates, each cancel reaches exactly the workflow run of its own (execution, epoch) and never another epoch's", async () => {
    const violations: string[] = [];
    const reached: Record<string, number> = {};
    for (const seed of seedsOf("gha-cancel", PR_SEEDS, readKeptSeeds())) {
      const run = await simulateCancels(seed);
      violations.push(...run.violations.map((v) => v.message));
      for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
    }
    expect(violations.slice(0, 5)).toEqual([]);
    // The seeds reach cancels of the current and of an earlier epoch, of a launch GitHub refused and of one never
    // started, repeated cancels, cancels beside a concurrent re-dispatch, and cancels on another isolate than the start.
    for (const k of [
      "cancel-current",
      "cancel-stale-epoch",
      "cancel-refused-launch",
      "cancel-unlaunched",
      "cancel-repeated",
      "cancel-beside-redispatch",
      "cancel-other-isolate",
    ])
      expect(reached[k], k).toBeGreaterThan(0);
  }, 120_000);

  it("replays a seed exactly", async () => {
    const first = await simulateCancels(7);
    expect((await simulateCancels(7)).trace).toEqual(first.trace);
  });
});
