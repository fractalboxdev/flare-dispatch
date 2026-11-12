// The verdict records of a deploy with `records.url` over 100 seeds plus every kept seed in the repository's
// `test/sim/seeds.jsonl`.
import { describe, expect, it } from "vitest";
import {
  PR_SEEDS,
  readKeptSeeds,
  seedsOf,
} from "../../../../packages/ops/src/verification/harness.ts";
import { simulateRecords } from "./records.sim.ts";

describe("simulation: executions end and their verdict records reach records.url, or are refused", () => {
  it("[FD-GH-094] [FD-GH-102] each terminal execution gets one verdict.record ops intent, and each refused record pages record-undelivered naming its execution with the verdict unchanged", async () => {
    const violations: string[] = [];
    const reached: Record<string, number> = {};
    for (const seed of seedsOf("verdict-records", PR_SEEDS, readKeptSeeds())) {
      const run = await simulateRecords(seed);
      violations.push(...run.violations.map((v) => v.message));
      for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
    }
    expect(violations.slice(0, 5)).toEqual([]);
    // The seeds reach records the endpoint accepts, refuses and retries, executions ending on the same minute, and
    // records that carry their check run's conclusion.
    expect(reached.accept).toBeGreaterThan(0);
    expect(reached.refuse).toBeGreaterThan(0);
    expect(reached.retry).toBeGreaterThan(0);
    expect(reached.endedTogether).toBeGreaterThan(0);
    expect(reached.concluded).toBeGreaterThan(0);
  }, 300_000);

  it("replays a seed exactly", async () => {
    const first = await simulateRecords(7);
    expect((await simulateRecords(7)).trace).toEqual(first.trace);
    expect(first.trace.length).toBeGreaterThan(0);
  });
});
