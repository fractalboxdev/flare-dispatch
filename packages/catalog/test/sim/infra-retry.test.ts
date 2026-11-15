// The infrastructure-error scenario over 100 seeds plus every kept seed (specs/verification.md § V-SIM, FD-VER-024),
// through the same checks the `sim` job runs. `SIM_SEEDS` sets the seed count, as the nightly run does with 10,000.
import { describe, expect, it } from "vitest";
import { readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import { observeSeed, runScenario, SCENARIO } from "./infra-retry.sim.ts";

const count = Number(process.env["SIM_SEEDS"] ?? 100);

describe("simulation: gate job infrastructure errors", () => {
  it("[FD-GATE-010] for seeded infrastructure-error schedules per class, a job records failure with infra: <error tag> exactly when its errors outlast the retries its class allows, and the retry's end otherwise", async () => {
    const violations: string[] = [];
    const reached: Record<string, number> = {};
    for (const seed of seedsOf(SCENARIO, count, readKeptSeeds())) {
      const r = await observeSeed(seed);
      violations.push(...r.violations.map((v) => `seed ${seed}: ${v.message}`));
      for (const [k, n] of Object.entries(r.reached)) reached[k] = (reached[k] ?? 0) + n;
    }
    expect(violations.slice(0, 5)).toEqual([]);
    // The seeds reach every infrastructure error outlasting a release job's retries and another class's, jobs whose
    // retries outlast their errors, and jobs the control plane's requeue carries through an `infra:` result.
    if (count >= 100) {
      for (const tag of ["checkout", "exec", "start", "no-verdict"])
        for (const side of ["release", "other"])
          expect(reached[`${side}-outlasted ${tag}`], `${side} ${tag}`).toBeGreaterThan(0);
      expect(reached["retried-through"]).toBeGreaterThan(0);
      expect(reached["requeued-through"]).toBeGreaterThan(0);
    }
  }, 120_000);

  it("replays a seed exactly", async () => {
    const first = await runScenario(11);
    const again = await runScenario(11);
    expect(again.starts).toEqual(first.starts);
    expect([...again.states]).toEqual([...first.states]);
  });
});
