// The device extension's L1 eviction under the free-disk floor over 100 seeds plus every kept seed. A failing seed
// goes into `seeds.jsonl` as `{"scenario": "evict", "seed": n}` so every later run replays it.
import { describe, expect, it } from "vitest";
import { seeds, simulateEviction } from "./evict.sim.ts";

describe("simulation: L1 eviction under the free-disk floor", () => {
  it("[FD-CACHE-010] cache.evict(target_bytes) evicts L1 entries least recently read first until target_bytes are freed or L1 is empty, and answers the bytes freed", () => {
    const violations: string[] = [];
    const reached: Record<string, number> = {};
    for (const seed of seeds("evict")) {
      const run = simulateEviction(seed);
      violations.push(...run.violations.map((v) => v.message));
      for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
    }
    expect(violations.slice(0, 5)).toEqual([]);
    // The seeds reach both endings: the target freed with entries left, and L1 emptied short of the target.
    expect(reached.partial).toBeGreaterThan(0);
    expect(reached.emptied).toBeGreaterThan(0);
  }, 120_000);

  it("replays a seed exactly", () => {
    const first = simulateEviction(5);
    expect(simulateEviction(5).trace).toEqual(first.trace);
    expect(first.reached.evictions).toBeGreaterThan(0);
  });
});
