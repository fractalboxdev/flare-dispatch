// The check-run lifecycle and the installation quota over 100 seeds each plus every kept seed in the repository's
// `test/sim/seeds.jsonl`.
import { describe, expect, it } from "vitest";
import {
  PR_SEEDS,
  readKeptSeeds,
  seedsOf,
} from "../../../../packages/ops/src/verification/harness.ts";
import {
  simulateApplyCaps,
  simulateCheckRunOnce,
  simulateInstallationReserve,
  simulateNoNeutralCapacity,
  type SimOutcome,
} from "./github-output.sim.ts";

/** Every seed of `scenario`: the first few violations, and how often each case of interest was reached. */
const sweep = async (scenario: string, simulate: (seed: number) => Promise<SimOutcome>) => {
  const violations: string[] = [];
  const reached: Record<string, number> = {};
  for (const seed of seedsOf(scenario, PR_SEEDS, readKeptSeeds())) {
    const run = await simulate(seed);
    violations.push(...run.violations.map((v) => `seed ${seed}: ${v.message}`));
    for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
  }
  return { violations: violations.slice(0, 5), reached };
};

describe("simulation: check runs under replays, retries, reclaims and GitHub faults", () => {
  it("[FD-GH-010] creates one check run per execution, found by external_id on every attempt", async () => {
    const { violations, reached } = await sweep("check-run-once", simulateCheckRunOnce);
    expect(violations).toEqual([]);
    for (const k of Object.keys(reached)) expect(reached[k], k).toBeGreaterThan(0);
  }, 300_000);

  it("replays a seed exactly", async () => {
    const first = await simulateCheckRunOnce(7);
    expect((await simulateCheckRunOnce(7)).trace).toEqual(first.trace);
    expect(first.trace.length).toBeGreaterThan(0);
  });
});

describe("simulation: conclusions of budget, capacity, deadline, halt and placement outcomes", () => {
  it("[FD-GH-027] concludes no such outcome neutral, for any class", async () => {
    const { violations, reached } = await sweep("no-neutral-capacity", simulateNoNeutralCapacity);
    expect(violations).toEqual([]);
    for (const k of Object.keys(reached)) expect(reached[k], k).toBeGreaterThan(0);
  }, 300_000);
});

describe("simulation: an installation at its reserve", () => {
  it("[FD-GH-058] grants permits only to check.open and check.conclude rows, mameko's outcome row included", async () => {
    const { violations, reached } = await sweep(
      "installation-reserve",
      simulateInstallationReserve,
    );
    expect(violations).toEqual([]);
    for (const k of Object.keys(reached)) expect(reached[k], k).toBeGreaterThan(0);
  }, 300_000);
});

describe("simulation: the content-creating caps", () => {
  it("[FD-GH-062] grants at most the configured apply permits in any 60 s and any hour; lookups are not counted", async () => {
    const { violations, reached } = await sweep("apply-caps", simulateApplyCaps);
    expect(violations).toEqual([]);
    for (const k of Object.keys(reached)) expect(reached[k], k).toBeGreaterThan(0);
  }, 300_000);
});
