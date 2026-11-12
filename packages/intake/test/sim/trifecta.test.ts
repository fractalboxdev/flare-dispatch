// The trifecta rule at admission over 100 seeds plus every kept seed in the repository's `test/sim/seeds.jsonl`.
import { describe, expect, it } from "vitest";
import { PR_SEEDS, readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import { simulateTrifecta } from "./trifecta.sim.ts";

const runSeeds = async () => {
  const violations: { id: string; message: string }[] = [];
  const reached: Record<string, number> = {};
  for (const seed of seedsOf("trifecta", PR_SEEDS, readKeptSeeds())) {
    const run = await simulateTrifecta(seed);
    violations.push(
      ...run.violations.map((v) => ({ ...v, message: `seed ${seed}: ${v.message}` })),
    );
    for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
  }
  return { violations, reached };
};

describe("simulation: data classes computed at admission and the trifecta refusal", () => {
  it("[FD-AGT-005] concludes failure with policy: trifecta before placement exactly when the computed privateData, untrustedInput and outbound classes are all true", async () => {
    const { violations, reached } = await runSeeds();
    expect(violations.slice(0, 5)).toEqual([]);
    // The seeds reach refusals of fork and same-repository pull requests, repeated deliveries of a refused request,
    // and requests that are queued or held instead.
    expect(reached.refused).toBeGreaterThan(0);
    expect(reached.refusedSameRepo).toBeGreaterThan(0);
    expect(reached.repeated).toBeGreaterThan(0);
    expect(reached.admitted).toBeGreaterThan(0);
    expect(reached.held).toBeGreaterThan(0);
  }, 300_000);

  it("replays a seed exactly", async () => {
    const first = await simulateTrifecta(7);
    expect((await simulateTrifecta(7)).trace).toEqual(first.trace);
    expect(first.trace.length).toBeGreaterThan(0);
  });
});
