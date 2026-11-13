// The log-append V-SIM scenario over the seeds a pull request runs: 100 plus every kept seed of it in the repository's
// `test/sim/seeds.jsonl`. Beyond the `sim` job's pass or fail, this checks that the seeds reach every case the
// property speaks about.
import { describe, expect, it } from "vitest";
import { PR_SEEDS, readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import { simulateLogAppend } from "./log-append.sim.ts";

describe("simulation: a log append that fails", () => {
  it("[FD-PROV-041] a failed log append is retried 5 s, then doubling to at most 10 min, after each failure until it succeeds, inside the one-minute tick when the retry falls due before the tick stops, and the check summary shows the statement as log-pending until then", async () => {
    const messages: string[] = [];
    const reached: Record<string, number> = {};
    for (const seed of seedsOf("log-append", PR_SEEDS, readKeptSeeds())) {
      const run = await simulateLogAppend(seed);
      messages.push(...run.violations.map((v) => `seed ${seed}: ${v.message}`));
      for (const [k, n] of Object.entries(run.reached)) reached[k] = (reached[k] ?? 0) + n;
    }
    expect(messages.slice(0, 5)).toEqual([]);
    // The seeds reach both logs, failed first appends, retries at their due times up to the 10 min cap, and the pending
    // line. A first attempt runs at a tick and every delay is a multiple of 5 s that keeps the retry out of a minute's
    // last 5 s, so no seed reaches the next-tick case; the scenario still checks it wherever it occurs.
    expect(reached.rekor).toBeGreaterThan(0);
    expect(reached.private).toBeGreaterThan(0);
    expect(reached.failedFirst).toBeGreaterThan(0);
    expect(reached.retries).toBeGreaterThan(0);
    expect(reached.cappedDelay).toBeGreaterThan(0);
    expect(reached.inTickRetry).toBeGreaterThan(0);
    expect(reached.pendingShown).toBeGreaterThan(0);
  }, 300_000);
});
