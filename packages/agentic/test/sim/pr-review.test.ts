// The pr-review scenarios over 100 seeds plus every kept seed (specs/verification.md § V-SIM, FD-VER-024), through
// the same checks the `sim` job runs. Kept seeds come from the repo-root `test/sim/seeds.jsonl` the harness reads and
// the nightly run appends to. `SIM_SEEDS` sets the seed count, as the nightly run does with 10,000.
import { describe, expect, it } from "vitest";
import { readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import {
  CAPACITY_SCENARIO,
  checkCapacity,
  checkPlacement,
  classOfLines,
  PLACEMENT_SCENARIO,
  plan,
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
    const classes = new Set<string>();
    for (const seed of seedsOf(CAPACITY_SCENARIO, count, kept)) {
      const o = await runScenario(seed);
      expect(checkCapacity(seed, o), `seed ${seed}`).toEqual([]);
      reasons.add(o.result._tag === "failure" ? o.result.reason : o.result._tag);
      if (plan(seed).mode === "all-rate-limited") classes.add(classOfLines(plan(seed).lines));
    }
    if (count >= 100) {
      expect([...reasons].sort()).toEqual([
        "capacity: model unavailable",
        "infra: every reviewer failed",
        "review: changes requested",
        "success",
      ]);
      // Every change class, so one reviewer and seven, reached the all-rate-limited path.
      expect([...classes].sort()).toEqual(["full", "lite", "trivial"]);
    }
  }, 120_000);
});
