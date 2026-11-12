// The local-work scenarios over 100 seeds plus every kept seed (specs/verification.md § V-SIM, FD-VER-024), through the
// same `check*` functions the `sim` job runs. Kept seeds come from the repository's `test/sim/seeds.jsonl`. `SIM_SEEDS`
// sets the seed count, as the nightly run does with 10,000.
import { describe, expect, it } from "vitest";
import { readKeptSeeds, seedsOf } from "../../../ops/src/verification/harness.ts";
import {
  checkGrantRejection,
  checkRegistration,
  GRANT_SCENARIO,
  REGISTRATION_SCENARIO,
} from "./local.sim.ts";

const count = Number(process.env["SIM_SEEDS"] ?? 100);
const kept = readKeptSeeds();

describe("local-work simulation", () => {
  it("[FD-LOCAL-071] once a new grant rejects a registered in-flight execution, the local scheduler sends no writeback request for it", async () => {
    const reached = new Set<string>();
    for (const seed of seedsOf(GRANT_SCENARIO, count, kept)) {
      const o = await checkGrantRejection(seed);
      for (const [path, hit] of Object.entries(o)) if (hit) reached.add(path);
    }
    if (count >= 100)
      expect([...reached].sort()).toEqual([
        "heldAfterRejection",
        "heldOffline",
        "inFlightAtGrant",
        "redelivered",
      ]);
  }, 120_000);

  it("[FD-LOCAL-075] a local execution registers exactly when it requests rehearsal reuse or writeback, across seeded orders and faults", async () => {
    const wants = new Set<string>();
    const reached = new Set<string>();
    for (const seed of seedsOf(REGISTRATION_SCENARIO, count, kept)) {
      const o = await checkRegistration(seed);
      for (const w of o.wants) wants.add(w);
      if (o.staleLease) reached.add("stale-lease");
      if (o.d1Failure) reached.add("d1-failure");
      if (o.unwantedRegister) reached.add("unwanted-register");
    }
    if (count >= 100) {
      expect([...wants].sort()).toEqual(["-/-", "-/writeback", "reuse/-", "reuse/writeback"]);
      expect([...reached].sort()).toEqual(["d1-failure", "stale-lease", "unwanted-register"]);
    }
  }, 120_000);
});
