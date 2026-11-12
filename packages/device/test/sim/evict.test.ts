// The device extension's L1 eviction under the free-disk floor over 100 seeds plus every kept seed in the repository's
// `test/sim/seeds.jsonl`, where the nightly run appends each failing seed.
import { describe, expect, it } from "vitest";
import { PR_SEEDS, readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import { simulateEviction } from "./evict.sim.ts";

describe("simulation: L1 eviction under the free-disk floor", () => {
  it("[FD-CACHE-010] cache.evict(target_bytes) evicts L1 entries least recently read first until target_bytes are freed or L1 is empty, and answers the bytes freed", async () => {
    const violations: string[] = [];
    const reached: Record<string, number> = {};
    for (const seed of seedsOf("evict", PR_SEEDS, readKeptSeeds())) {
      const run = await simulateEviction(seed);
      violations.push(...run.violations.map((v) => v.message));
      for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
    }
    expect(violations.slice(0, 5)).toEqual([]);
    // The seeds reach both endings: the target freed with entries left, and L1 emptied short of the target.
    expect(reached.partial).toBeGreaterThan(0);
    expect(reached.emptied).toBeGreaterThan(0);
  }, 120_000);

  it("replays a seed exactly", async () => {
    const first = await simulateEviction(5);
    expect((await simulateEviction(5)).trace).toEqual(first.trace);
    expect(first.reached.evictions).toBeGreaterThan(0);
  });
});
