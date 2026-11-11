// The cache's V-SIM scenarios over the seeds a pull request runs: 100 per scenario plus every kept seed in the
// repository's `test/sim/seeds.jsonl`, where the nightly run appends each failing seed. Beyond the `sim` job's pass or
// fail, these check that the seeds reach every case a property speaks about.
import { describe, expect, it } from "vitest";
import { PR_SEEDS, readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import type { ManifestSignerService } from "../../src/manifest.ts";
import { signerOnce, simulateReclaim, simulateSweep, type SimOutcome } from "./cache.sim.ts";

type Scenario = (seed: number, signer: ManifestSignerService) => Promise<SimOutcome>;

/** Runs a scenario over every seed, each on its own bucket and clock; run once per scenario. */
const runs = new Map<
  string,
  Promise<{ violations: SimOutcome["violations"]; reached: Record<string, number> }>
>();
const runAll = (name: string, scenario: Scenario) => {
  const existing = runs.get(name);
  if (existing !== undefined) return existing;
  const outcome = (async () => {
    const signer = await signerOnce();
    const violations: SimOutcome["violations"][number][] = [];
    const reached: Record<string, number> = {};
    for (const seed of seedsOf(name, PR_SEEDS, readKeptSeeds())) {
      const run = await scenario(seed, signer);
      violations.push(...run.violations);
      for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
    }
    return { violations, reached };
  })();
  runs.set(name, outcome);
  return outcome;
};

const messagesFor = (violations: SimOutcome["violations"], id: string) =>
  violations
    .filter((v) => v.id === id)
    .map((v) => v.message)
    .slice(0, 5);

describe("simulation: reclaim and revoke across epochs", () => {
  it("[FD-CACHE-051] after a reclaim or a revoke every URL request and compile-cache token of an earlier epoch is refused and its uploads never become an entry, while the current epoch's are served with URLs that live at most 15 min under its own path", async () => {
    const { violations, reached } = await runAll("reclaim", simulateReclaim);
    expect(messagesFor(violations, "FD-CACHE-051")).toEqual([]);
    // The seeds reach both sides of every reclaim and revoke.
    expect(reached.reclaims).toBeGreaterThan(0);
    expect(reached.revokes).toBeGreaterThan(0);
    expect(reached.stalePresign).toBeGreaterThan(0);
    expect(reached.staleToken).toBeGreaterThan(0);
    expect(reached.currentPresign).toBeGreaterThan(0);
    expect(reached.currentToken).toBeGreaterThan(0);
  }, 300_000);

  it("[FD-CACHE-040] a manifest commit is accepted under the execution's current epoch and answered stale, writing no manifest, under an earlier one", async () => {
    const { violations, reached } = await runAll("reclaim", simulateReclaim);
    expect(messagesFor(violations, "FD-CACHE-040")).toEqual([]);
    expect(reached.currentCommit).toBeGreaterThan(0);
    expect(reached.staleCommit).toBeGreaterThan(0);
  }, 300_000);

  it("[FD-CACHE-002] no executor of a later epoch is handed an upload an earlier epoch never committed, and no epoch gets a URL or a grant prefix for a checkout, workspace or build output", async () => {
    const { violations, reached } = await runAll("reclaim", simulateReclaim);
    expect(messagesFor(violations, "FD-CACHE-002")).toEqual([]);
    expect(reached.refusedTransfer).toBeGreaterThan(0);
    expect(reached.refusedWorkspaceKey).toBeGreaterThan(0);
  }, 300_000);

  it("replays a seed exactly", async () => {
    const signer = await signerOnce();
    const first = await simulateReclaim(7, signer);
    const second = await simulateReclaim(7, signer);
    expect(second.trace).toEqual(first.trace);
    expect(first.trace.length).toBeGreaterThan(10);
  }, 60_000);
});

describe("simulation: cache sweep over 40 days", () => {
  it("[FD-CACHE-062] each sweep tick deletes exactly the entries whose last_read_at is more than 14 days old, each with every object, and keeps the rest", async () => {
    const { violations, reached } = await runAll("sweep", simulateSweep);
    expect(messagesFor(violations, "FD-CACHE-062")).toEqual([]);
    // The seeds reach expiry, survival, a read that refreshes last_read_at, and ticks on the TTL's boundary.
    expect(reached.expired).toBeGreaterThan(0);
    expect(reached.kept).toBeGreaterThan(0);
    expect(reached.refreshed).toBeGreaterThan(0);
    expect(reached.boundary).toBeGreaterThan(0);
  }, 300_000);

  it("replays a seed exactly", async () => {
    const signer = await signerOnce();
    const first = await simulateSweep(11, signer);
    const second = await simulateSweep(11, signer);
    expect(second.trace).toEqual(first.trace);
  }, 60_000);
});
