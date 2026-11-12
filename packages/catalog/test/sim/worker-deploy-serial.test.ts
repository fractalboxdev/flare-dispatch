// The `worker-deploy` serial group over 100 seeds plus every kept seed in the repository's `test/sim/seeds.jsonl`.
import { describe, expect, it } from "vitest";
import { PR_SEEDS, readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import { simulateSerialDeploys } from "./worker-deploy-serial.sim.ts";

const runSeeds = async () => {
  const violations: { id: string; message: string }[] = [];
  const reached: Record<string, number> = {};
  for (const seed of seedsOf("worker-deploy-serial", PR_SEEDS, readKeptSeeds())) {
    const run = await simulateSerialDeploys(seed);
    violations.push(...run.violations);
    for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
  }
  return { violations, reached };
};

describe("simulation: worker-deploy executions of one target in its serial group", () => {
  let seeds: Promise<Awaited<ReturnType<typeof runSeeds>>> | undefined;
  const results = () => (seeds ??= runSeeds());

  it("[FD-GATE-063] holds at most one leased worker-deploy member of one repository, branch and label at a time", async () => {
    const { violations, reached } = await results();
    expect(violations.filter((v) => v.id === "FD-GATE-063").slice(0, 5)).toEqual([]);
    // The seeds reach a waiter refused behind a live holder, a reclaimed holder and a superseded waiter.
    expect(reached.waiterRefused).toBeGreaterThan(0);
    expect(reached.reclaimed).toBeGreaterThan(0);
    expect(reached.superseded).toBeGreaterThan(0);
  }, 300_000);

  it("[FD-GATE-065] cancels a granted deploy whose commit is no longer the branch head with superseded: branch head moved, and deploys only the head", async () => {
    const { violations, reached } = await results();
    expect(violations.filter((v) => v.id === "FD-GATE-065").slice(0, 5)).toEqual([]);
    expect(reached.headMoved).toBeGreaterThan(0);
    expect(reached.deployed).toBeGreaterThan(0);
  }, 300_000);

  it("replays a seed exactly", async () => {
    const first = await simulateSerialDeploys(7);
    expect((await simulateSerialDeploys(7)).trace).toEqual(first.trace);
    expect(first.trace.length).toBeGreaterThan(0);
  });
});
