// A cooldown run's check run over 100 seeds plus every kept seed in the repository's `test/sim/seeds.jsonl`.
import { describe, expect, it } from "vitest";
import { PR_SEEDS, readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import { simulateCooldownChecks } from "./cooldown-check.sim.ts";

const runSeeds = async () => {
  const violations: { id: string; message: string }[] = [];
  const reached: Record<string, number> = {};
  for (const seed of seedsOf("cooldown-check", PR_SEEDS, readKeptSeeds())) {
    const run = await simulateCooldownChecks(seed);
    violations.push(
      ...run.violations.map((v) => ({ ...v, message: `seed ${seed}: ${v.message}` })),
    );
    for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
  }
  return { violations, reached };
};

describe("simulation: a cooldown run's check run through hold, release and the outbox", () => {
  it("[FD-INT-057] keeps a held request's check run queued until its window ends, and check.open adopts it at release", async () => {
    const { violations, reached } = await runSeeds();
    expect(violations.slice(0, 5)).toEqual([]);
    // The seeds reach held requests, held requests whose check run `check.open` adopted, and held requests release
    // answered with another execution.
    expect(reached.held).toBeGreaterThan(0);
    expect(reached.adopted).toBeGreaterThan(0);
    expect(reached.dropped).toBeGreaterThan(0);
  }, 300_000);

  it("replays a seed exactly", async () => {
    const first = await simulateCooldownChecks(7);
    expect((await simulateCooldownChecks(7)).trace).toEqual(first.trace);
    expect(first.trace.length).toBeGreaterThan(0);
  });
});
