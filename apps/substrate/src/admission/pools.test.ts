import { describe, expect, it } from "vitest";
import {
  POOL_CAPS_DEFAULT,
  POOLS,
  resolvePoolCaps,
  selectPool,
  validatePoolCaps,
} from "./pools";

describe("pool selection (ADR-0010)", () => {
  it("is policy-selected from the consumer, never from an input field", () => {
    // fractalbot's tasks land on the task image; the dispatcher on lean until
    // its run catalog migrates with per-run class policy.
    expect(selectPool("fractalbot", { version: 1 })).toBe("task");
    expect(selectPool("dispatcher", { version: 1 })).toBe("lean");
    // The recipe carries no field that could steer this — the signature only
    // takes it so future policy can consider reviewed run definitions.
    expect(selectPool("fractalbot", { version: 1, repo: { owner: "a", name: "b" } })).toBe("task");
  });
});

describe("resolvePoolCaps", () => {
  it("returns the shipped partition when unset", () => {
    expect(resolvePoolCaps(undefined)).toEqual(POOL_CAPS_DEFAULT);
  });

  it("applies a partial override and keeps the rest", () => {
    expect(resolvePoolCaps('{"task": 8}')).toEqual({ ...POOL_CAPS_DEFAULT, task: 8 });
  });

  it("degrades a typo to the default, never to an unmetered pool", () => {
    expect(resolvePoolCaps("not json")).toEqual(POOL_CAPS_DEFAULT);
    expect(resolvePoolCaps('{"task": 0}')).toEqual(POOL_CAPS_DEFAULT);
    expect(resolvePoolCaps('{"task": -2}')).toEqual(POOL_CAPS_DEFAULT);
    expect(resolvePoolCaps('{"task": "lots"}')).toEqual(POOL_CAPS_DEFAULT);
  });
});

describe("validatePoolCaps — the cap-sum guard (ADR-0004)", () => {
  it("accepts the shipped partition under the shipped ceiling", () => {
    const sum = POOLS.reduce((a, p) => a + POOL_CAPS_DEFAULT[p], 0);
    expect(() => validatePoolCaps(POOL_CAPS_DEFAULT, sum)).not.toThrow();
  });

  it("throws when the partition exceeds the ceiling — deploy-time, not 2am", () => {
    expect(() => validatePoolCaps(POOL_CAPS_DEFAULT, 3)).toThrow(/over the Containers ceiling/);
  });

  it("throws on a non-positive pool cap", () => {
    expect(() => validatePoolCaps({ ...POOL_CAPS_DEFAULT, lean: 0 }, 100)).toThrow(/non-positive/);
  });
});
