// The minute tick's units over 100 seeds plus every kept seed in the repository's `test/sim/seeds.jsonl`.
import { describe, expect, it } from "vitest";
import { PR_SEEDS, readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import { simulations } from "./tick.sim.ts";

describe("simulation: the minute tick's units in their own alarms", () => {
  it("[FD-INT-067] the tick only enqueues; each alarm runs one unit within 500 D1 queries and 1,000 subrequests, and its cursor reaches every repository", async () => {
    const simulate = simulations["tick-units"]!;
    const violations: { id: string; message: string }[] = [];
    const reached: Record<string, number> = {};
    for (const seed of seedsOf("tick-units", PR_SEEDS, readKeptSeeds())) {
      const run = await simulate(seed);
      violations.push(
        ...run.violations.map((v) => ({
          ...v,
          message: `seed ${seed}: ${v.message}`,
        })),
      );
      for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
    }
    expect(violations.slice(0, 5)).toEqual([]);
    const cases = [
      "continued",
      "d1Bound",
      "subrequestBound",
      "midPull",
      "laterRepository",
      "refired",
      "unreadable",
    ];
    expect(Object.fromEntries(cases.map((c) => [c, (reached[c] ?? 0) > 0]))).toEqual(
      Object.fromEntries(cases.map((c) => [c, true])),
    );
  }, 300_000);

  it("replays a seed exactly", async () => {
    const simulate = simulations["tick-units"]!;
    const first = await simulate(7);
    expect((await simulate(7)).trace).toEqual(first.trace);
    expect(first.trace.length).toBeGreaterThan(0);
  }, 120_000);
});
