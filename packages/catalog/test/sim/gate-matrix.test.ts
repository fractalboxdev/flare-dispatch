// The job-matrix scenario over 100 seeds plus every kept seed (specs/verification.md § V-SIM, FD-VER-024), through
// the same checks the `sim` job runs. Each test asserts that no seed broke its requirement and that the seeds reached
// the paths the requirement covers. `SIM_SEEDS` sets the seed count, as the nightly run does with 10,000.
import { describe, expect, it } from "vitest";
import { readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import { observeSeed, SCENARIO, type SeedResult } from "./gate-matrix.sim.ts";

const count = Number(process.env["SIM_SEEDS"] ?? 100);
const seeds = seedsOf(SCENARIO, count, readKeptSeeds());

/** Every seed's result, run once and shared by the tests below. */
let all: Promise<readonly (SeedResult & { readonly seed: number })[]> | undefined;
const runAll = () =>
  (all ??= (async () => {
    const results: (SeedResult & { seed: number })[] = [];
    for (const seed of seeds) results.push({ seed, ...(await observeSeed(seed)) });
    return results;
  })());

/** The violations of one requirement across every seed, each with its seed. */
const violationsOf = async (id: string) =>
  (await runAll()).flatMap((r) =>
    r.violations.filter((v) => v.id === id).map((v) => `seed ${r.seed}: ${v.message}`),
  );

const reached = async (path: keyof SeedResult["reached"]) =>
  (await runAll()).some((r) => r.reached[path]);

describe("job matrix simulation", () => {
  it("[FD-GATE-033] keeps at most window jobs placed or running, 10 when unset, and refuses a window outside 1 to 64", async () => {
    expect(await violationsOf("FD-GATE-033")).toEqual([]);
    if (count >= 100) {
      expect(await reached("defaultBound")).toBe(true);
      expect(await reached("setBound")).toBe(true);
      expect(await reached("outOfRange")).toBe(true);
    }
  }, 120_000);

  it("[FD-GATE-041] counts a job whose execution ended with no verdict as failure with infra: no verdict", async () => {
    expect(await violationsOf("FD-GATE-041")).toEqual([]);
    if (count >= 100) expect(await reached("noVerdict")).toBe(true);
  }, 120_000);

  it("[FD-GATE-044] starts no further job after one records a budget, capacity or operator-halt failure", async () => {
    expect(await violationsOf("FD-GATE-044")).toEqual([]);
    if (count >= 100) expect(await reached("stoppedEarly")).toBe(true);
  }, 120_000);
});
