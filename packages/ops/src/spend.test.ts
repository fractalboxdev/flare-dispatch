import { spendDefaults } from "@fractalboxdev/flare-dispatch-profile";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { spendConfigOfVar } from "./index.ts";

const read = (value: unknown) => Effect.runSync(spendConfigOfVar(value));
const refused = (value: unknown) => Effect.runSync(Effect.flip(spendConfigOfVar(value)));

const SET = {
  budgetUsd: 120,
  fixedUsd: 4.5,
  releaseReserveUsd: 15,
  opsReserveUsd: 6,
  measuredReserveMinUsd: 25,
  measuredReserveDays: 14,
  overheadFactor: 1.25,
};

describe("the SPEND var", () => {
  it("[FD-PROF-054] delivers B, F, the release reserve, R_ops, R_m,min, D and the overhead factor in micro-USD", () => {
    const expected = {
      budget: 120_000_000,
      fixed: 4_500_000,
      reserves: { "release-reserve": 15_000_000 },
      ops_reserve: 6_000_000,
      measured_reserve_min: 25_000_000,
      measured_reserve_days: 14,
      overhead_factor: 1.25,
    };
    // A rendered JSON var arrives as the object; a text var as its JSON.
    expect(read(SET)).toEqual(expected);
    expect(read(JSON.stringify(SET))).toEqual(expected);
  });

  it("[FD-PROF-054] keeps the default of each value the var leaves out, and every default with no var", () => {
    expect(read(undefined)).toEqual(spendDefaults);
    expect(read({})).toEqual(spendDefaults);
    expect(read({ budgetUsd: 80 })).toEqual({ ...spendDefaults, budget: 80_000_000 });
  });

  it("[FD-PROF-054] refuses a var that is not the overlay's spend values, naming it", () => {
    expect(refused("{not json").reason).toBe("SPEND is not JSON");
    expect(refused({ budgetUsd: -1 }).reason).toContain("SPEND.budgetUsd");
    expect(refused({ budget: 50 }).reason).toContain("SPEND.budget");
    expect(refused({ overheadFactor: 0.9 }).reason).toContain("SPEND.overheadFactor");
  });
});
