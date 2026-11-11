// A fan-out parent's end and its children's check runs over 100 seeds plus every kept seed in the repository's
// `test/sim/seeds.jsonl`.
import { describe, expect, it } from "vitest";
import {
  PR_SEEDS,
  readKeptSeeds,
  seedsOf,
} from "../../../../packages/ops/src/verification/harness.ts";
import { simulateChildConclusions } from "./child-conclusions.sim.ts";

describe("simulation: a fan-out parent reaches its outcome while child check runs are open", () => {
  it("[FD-GH-020] concludes every child check run not yet concluded, with the child's outcome or parent closed", async () => {
    const violations: string[] = [];
    const reached: Record<string, number> = {};
    for (const seed of seedsOf("child-conclusions", PR_SEEDS, readKeptSeeds())) {
      const run = await simulateChildConclusions(seed);
      violations.push(...run.violations.map((v) => v.message));
      for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
    }
    expect(violations.slice(0, 5)).toEqual([]);
    // The seeds reach children with their own outcome, children the parent closed, checks concluded before the
    // parent's end, cascade rows drained before the pass, and children that own no check run.
    expect(reached.ownOutcome).toBeGreaterThan(0);
    expect(reached.parentClosed).toBeGreaterThan(0);
    expect(reached.concludedFirst).toBeGreaterThan(0);
    expect(reached.cascadeDrainedFirst).toBeGreaterThan(0);
    expect(reached.noCheck).toBeGreaterThan(0);
  }, 300_000);

  it("replays a seed exactly", async () => {
    const first = await simulateChildConclusions(7);
    expect((await simulateChildConclusions(7)).trace).toEqual(first.trace);
    expect(first.trace.length).toBeGreaterThan(0);
  });
});
