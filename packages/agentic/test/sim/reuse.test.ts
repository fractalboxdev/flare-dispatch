// The rehearsal-reuse scenario over 100 seeds plus every kept seed (specs/verification.md § V-SIM, FD-VER-024), through
// the same `checkReuse` the `sim` job runs. Kept seeds come from the repository's `test/sim/seeds.jsonl`. `SIM_SEEDS`
// sets the seed count, as the nightly run does with 10,000.
import { describe, expect, it } from "vitest";
import { readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import { checkReuse, SCENARIO, type Defect } from "./reuse.sim.ts";

const count = Number(process.env["SIM_SEEDS"] ?? 100);
const kept = readKeptSeeds();

const DEFECTS: readonly Defect[] = [
  "base-commit",
  "environment-names",
  "epoch-not-issued",
  "image-digest",
  "not-started",
  "outcome-not-success",
  "platform",
  "run",
  "run-digest",
  "started-before-registration",
  "statement-none",
  "statement-rejected",
  "tree-hash",
];

describe("rehearsal-reuse simulation", () => {
  it("[FD-LOCAL-078] names a rehearsal only when it registered before it started, ran under an issued epoch, matches the run's provenance and carries an accepted device-signed statement", async () => {
    const sole = new Set<Defect>();
    const reached = new Set<string>();
    for (const seed of seedsOf(SCENARIO, count, kept)) {
      const o = await checkReuse(seed);
      for (const d of o.soleDefects) sole.add(d);
      if (o.named) reached.add("named");
      if (o.namedOnEquivalentPlatform) reached.add("equivalent-platform");
      if (o.noneEligible) reached.add("none-eligible");
      if (o.epochReadFailed) reached.add("epoch-read-failed");
      if (o.otherScopeMatch) reached.add("other-scope");
    }
    if (count >= 100) {
      expect([...sole].sort()).toEqual(DEFECTS);
      expect([...reached].sort()).toEqual([
        "epoch-read-failed",
        "equivalent-platform",
        "named",
        "none-eligible",
        "other-scope",
      ]);
    }
  }, 120_000);
});
