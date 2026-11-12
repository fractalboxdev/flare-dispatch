// The writeback-refusal scenario over 100 seeds plus every kept seed (specs/verification.md § V-SIM, FD-VER-024),
// through the same `checkSeed` the `sim` job runs. Kept seeds come from the repo-root `test/sim/seeds.jsonl` the
// harness reads and the nightly run appends to. `SIM_SEEDS` sets the seed count, as the nightly run does with 10,000.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkSeed, SCENARIO } from "./writeback-refusal.sim.ts";

const SEEDS_FILE = fileURLToPath(new URL("../../../../test/sim/seeds.jsonl", import.meta.url));
const kept = existsSync(SEEDS_FILE)
  ? readFileSync(SEEDS_FILE, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { scenario: string; seed: number })
      .filter((k) => k.scenario === SCENARIO)
      .map((k) => k.seed)
  : [];
const count = Number(process.env["SIM_SEEDS"] ?? 100);
const seeds = [...new Set([...Array.from({ length: count }, (_, i) => i + 1), ...kept])];

describe("writeback-refusal simulation", () => {
  it("[FD-AGT-018] a rejected staged write ends its pr.propose row refused with every gate reason, the page lists each one, and the verdict stays success (MAMEKO-OUT-015)", async () => {
    const outcomes = new Set<string>();
    const reached = new Set<string>();
    for (const seed of seeds) {
      const o = await checkSeed(seed);
      outcomes.add(o.rowState);
      if (o.d1LostAnswer) reached.add("d1-lost-answer");
      if (o.github502) reached.add("github-502");
    }
    if (count >= 100) {
      expect([...outcomes].sort()).toEqual(["expired", "refused"]);
      expect([...reached].sort()).toEqual(["d1-lost-answer", "github-502"]);
    }
  }, 120_000);
});
