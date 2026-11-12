// Intake's scenarios over 100 seeds each plus every kept seed in the repository's `test/sim/seeds.jsonl`.
import { describe, expect, it } from "vitest";
import { PR_SEEDS, readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import { simulations } from "./intake.sim.ts";

const runSeeds = async (scenario: string) => {
  const simulate = simulations[scenario]!;
  const violations: { id: string; message: string }[] = [];
  const reached: Record<string, number> = {};
  for (const seed of seedsOf(scenario, PR_SEEDS, readKeptSeeds())) {
    const run = await simulate(seed);
    violations.push(
      ...run.violations.map((v) => ({ ...v, message: `seed ${seed}: ${v.message}` })),
    );
    for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
  }
  return { violations, reached };
};

/** Every case the scenario exists to reach is reached by some seed. */
const reachedEvery = (reached: Record<string, number>, cases: readonly string[]) =>
  expect(Object.fromEntries(cases.map((c) => [c, (reached[c] ?? 0) > 0]))).toEqual(
    Object.fromEntries(cases.map((c) => [c, true])),
  );

describe("simulation: intake under redeliveries, D1 failures, manifest failures and repeated ticks", () => {
  it("[FD-INT-003] a redelivered webhook or reused key answers the existing execution with duplicate: true, and a reused key with another body 409 conflict naming it", async () => {
    const { violations, reached } = await runSeeds("redelivery");
    expect(violations.slice(0, 5)).toEqual([]);
    reachedEvery(reached, ["webhookDuplicate", "crossPath", "idemDuplicate", "conflict", "held"]);
  }, 300_000);

  it("[FD-INT-004] an admission transaction that fails answers 503 intake_unavailable and writes nothing; the next request admits", async () => {
    const { violations, reached } = await runSeeds("admission-failure");
    expect(violations.slice(0, 5)).toEqual([]);
    reachedEvery(reached, ["unavailable", "admittedAfter"]);
  }, 300_000);

  it("[FD-INT-019] a manifest read that fails with a 5xx or stalls 10 s submits nothing and sheds manifest: unreadable", async () => {
    const { violations, reached } = await runSeeds("manifest-read");
    expect(violations.slice(0, 5)).toEqual([]);
    reachedEvery(reached, ["failed", "stalled", "slow", "cached"]);
  }, 300_000);

  it("[FD-INT-032] every 10 min the sweep submits a webhook trigger for each recent head, up to 100 per installation, that lacks a required check run", async () => {
    const { violations, reached } = await runSeeds("sweep");
    expect(violations.slice(0, 5)).toEqual([]);
    reachedEvery(reached, ["sweeps", "submitted", "capped", "aged", "covered", "continued"]);
  }, 300_000);

  it("[FD-INT-053] a minute's tick fired more than once creates at most one execution per run, label and repository", async () => {
    const { violations, reached } = await runSeeds("double-tick");
    expect(violations.slice(0, 5)).toEqual([]);
    reachedEvery(reached, ["refired", "late", "matched"]);
  }, 300_000);

  it("replays a seed exactly", async () => {
    for (const simulate of Object.values(simulations)) {
      const first = await simulate(7);
      expect((await simulate(7)).trace).toEqual(first.trace);
      expect(first.trace.length).toBeGreaterThan(0);
    }
  }, 120_000);
});
