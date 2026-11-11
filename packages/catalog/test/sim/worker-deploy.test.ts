// The `worker-deploy` scenario over 100 seeds plus every kept seed (specs/verification.md § V-SIM, FD-VER-024),
// through the same checks the `sim` job runs. Each test asserts that no seed broke its requirement and that the seeds
// reached the paths the requirement covers. `SIM_SEEDS` sets the seed count, as the nightly run does with 10,000.
import { describe, expect, it } from "vitest";
import { readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import { observeSeed, SCENARIO, type SeedResult } from "./worker-deploy.sim.ts";

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

const violationsOf = async (id: string) =>
  (await runAll()).flatMap((r) =>
    r.violations.filter((v) => v.id === id).map((v) => `seed ${r.seed}: ${v.message}`),
  );

const reached = async (path: keyof SeedResult["reached"]) =>
  (await runAll()).some((r) => r.reached[path]);

describe("worker-deploy simulation", () => {
  it("[FD-GATE-064] reads the branch head before the deploy command in every epoch, and deploys with that epoch's read", async () => {
    expect(await violationsOf("FD-GATE-064")).toEqual([]);
    if (count >= 100) expect(await reached("redeployedAfterReclaim")).toBe(true);
  }, 120_000);

  it("[FD-GATE-065] cancels an epoch that finds the head moved with superseded: branch head moved and runs no deploy, unless requireHead is false", async () => {
    expect(await violationsOf("FD-GATE-065")).toEqual([]);
    if (count >= 100) {
      expect(await reached("supersededAfterReclaim")).toBe(true);
      expect(await reached("deployedMovedHead")).toBe(true);
    }
  }, 120_000);
});
