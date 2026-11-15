// The job matrix's child isolation over 100 seeds plus every kept seed (specs/verification.md § V-SIM, FD-VER-024),
// through the same checks the `sim` job runs. `SIM_SEEDS` sets the seed count, as the nightly run does with 10,000.
import { afterAll, describe, expect, it } from "vitest";
import { readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import { removeRepository, SCENARIO, simulateIsolation } from "./child-isolation.sim.ts";

const count = Number(process.env["SIM_SEEDS"] ?? 100);

afterAll(removeRepository);

describe("simulation: job matrix children", () => {
  it("[FD-GATE-030] for random matrices, each job runs as its own child execution with its own placement, execution lease, hold and workspace, and no two jobs share a workspace", async () => {
    const violations: string[] = [];
    const reached: Record<string, number> = {};
    for (const seed of seedsOf(SCENARIO, count, readKeptSeeds())) {
      const run = await simulateIsolation(seed);
      violations.push(...run.violations.map((v) => `seed ${seed}: ${v.message}`));
      for (const [k, n] of Object.entries(run.reached))
        reached[k] = k === "most-live" ? Math.max(reached[k] ?? 0, n) : (reached[k] ?? 0) + n;
    }
    expect(violations.slice(0, 5)).toEqual([]);
    // The seeds reach jobs whose workspaces exist at once and children that share a claiming executor.
    if (count >= 100) {
      expect(reached["most-live"]).toBeGreaterThan(1);
      expect(reached["shared-executor"]).toBeGreaterThan(0);
    }
  }, 300_000);

  it("replays a seed exactly", async () => {
    const first = await simulateIsolation(3);
    expect((await simulateIsolation(3)).trace).toEqual(first.trace);
  }, 60_000);
});
