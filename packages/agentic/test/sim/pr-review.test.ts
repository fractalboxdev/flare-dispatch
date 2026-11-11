// The pr-review scenarios over 100 seeds plus every kept seed (specs/verification.md § V-SIM, FD-VER-024), through
// the same checks the `sim` job runs. Kept seeds come from the repo-root `test/sim/seeds.jsonl` the harness reads and
// the nightly run appends to. `SIM_SEEDS` sets the seed count, as the nightly run does with 10,000.
import { describe, expect, it } from "vitest";
import { readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import {
  CAPACITY_SCENARIO,
  checkCapacity,
  checkPlacement,
  PLACEMENT_SCENARIO,
  plan,
  reviewerEnds,
  runScenario,
} from "./pr-review.sim.ts";

const count = Number(process.env["SIM_SEEDS"] ?? 100);
const kept = readKeptSeeds();

describe("pr-review simulation", () => {
  it("[FD-AGT-047] every dispatched pr-review is admitted interactive, its cloud entry opens 300 s after admission, and its deadline_at carries the 1500 s run ceiling", async () => {
    let executions = 0;
    for (const seed of seedsOf(PLACEMENT_SCENARIO, count, kept)) {
      const o = await runScenario(seed);
      executions += o.admitted.length;
      expect(checkPlacement(o), `seed ${seed}`).toEqual([]);
    }
    if (count >= 100) expect(executions).toBeGreaterThan(count);
  }, 120_000);

  it("[FD-AGT-057] when every reviewer's call ends rate-limited after its wait bound, pr-review concludes failure with capacity: model unavailable", async () => {
    const reasons = new Set<string>();
    const reviewerCounts = new Set<number>();
    for (const seed of seedsOf(CAPACITY_SCENARIO, count, kept)) {
      const o = await runScenario(seed);
      expect(checkCapacity(seed, o), `seed ${seed}`).toEqual([]);
      reasons.add(o.result._tag === "failure" ? o.result.reason : o.result._tag);
      const p = plan(seed);
      if (p.mode === "all-rate-limited") reviewerCounts.add(reviewerEnds(p, o.callSites).size);
    }
    if (count >= 100) {
      expect([...reasons].sort()).toEqual([
        "capacity: model unavailable",
        "infra: every reviewer failed",
        "review: changes requested",
        "success",
      ]);
      // Every change class reached the all-rate-limited path with its full reviewer set: one, four and seven.
      expect([...reviewerCounts].sort((a, b) => a - b)).toEqual([1, 4, 7]);
    }
  }, 120_000);
});
