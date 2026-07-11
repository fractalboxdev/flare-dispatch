import { describe, expect, it } from "vitest";
import { checkAndArmCooldown, cooldownKey } from "./cooldown";
import { makeFakeKv } from "./test-helpers";

const COOLDOWN = { seconds: 1800, scope: (input: unknown) => `pr-${(input as { pr: number }).pr}` };

const base = {
  runName: "pr-review",
  cooldown: COOLDOWN,
  repo: "acme/widgets",
  inputs: { pr: 7 },
} as const;

describe("checkAndArmCooldown", () => {
  it("arms an open window and records the execution id", async () => {
    const kv = makeFakeKv();
    const verdict = await checkAndArmCooldown({
      ...base,
      kv: kv.binding,
      executionId: "exec-1",
      now: 1_000_000,
    });
    expect(verdict).toEqual({ state: "armed" });
    const raw = kv.store.get(cooldownKey("pr-review", "acme/widgets", "pr-7"));
    expect(JSON.parse(raw!)).toEqual({ executionId: "exec-1", armedAt: 1_000_000 });
  });

  it("cools a dispatch inside the window, answering with the prior id", async () => {
    const kv = makeFakeKv();
    await checkAndArmCooldown({ ...base, kv: kv.binding, executionId: "exec-1", now: 1_000_000 });
    const verdict = await checkAndArmCooldown({
      ...base,
      kv: kv.binding,
      executionId: "exec-2",
      now: 1_000_000 + 10 * 60 * 1000, // 10 min later — inside the 30-min window
    });
    expect(verdict).toEqual({
      state: "cooling",
      priorExecutionId: "exec-1",
      retryAfterSec: 20 * 60,
    });
    // The window is NOT re-armed by a skipped dispatch.
    const raw = kv.store.get(cooldownKey("pr-review", "acme/widgets", "pr-7"));
    expect(JSON.parse(raw!).executionId).toBe("exec-1");
  });

  it("re-arms once the window has elapsed (stale record, TTL not yet purged)", async () => {
    const kv = makeFakeKv();
    await checkAndArmCooldown({ ...base, kv: kv.binding, executionId: "exec-1", now: 1_000_000 });
    const verdict = await checkAndArmCooldown({
      ...base,
      kv: kv.binding,
      executionId: "exec-2",
      now: 1_000_000 + 31 * 60 * 1000, // 31 min later — window elapsed
    });
    expect(verdict).toEqual({ state: "armed" });
    const raw = kv.store.get(cooldownKey("pr-review", "acme/widgets", "pr-7"));
    expect(JSON.parse(raw!).executionId).toBe("exec-2");
  });

  it("scopes per PR — a different PR is unaffected by an armed window", async () => {
    const kv = makeFakeKv();
    await checkAndArmCooldown({ ...base, kv: kv.binding, executionId: "exec-1", now: 1_000_000 });
    const verdict = await checkAndArmCooldown({
      ...base,
      inputs: { pr: 8 },
      kv: kv.binding,
      executionId: "exec-2",
      now: 1_000_000 + 1000,
    });
    expect(verdict).toEqual({ state: "armed" });
  });

  it("always arms with no cooldown declared or no KV binding", async () => {
    const kv = makeFakeKv();
    expect(
      await checkAndArmCooldown({
        ...base,
        cooldown: undefined,
        kv: kv.binding,
        executionId: "exec-1",
        now: 1,
      }),
    ).toEqual({ state: "armed" });
    expect(kv.store.size).toBe(0);
    expect(
      await checkAndArmCooldown({ ...base, kv: undefined, executionId: "exec-1", now: 1 }),
    ).toEqual({ state: "armed" });
  });

  it("treats an unparseable record as an open window instead of wedging", async () => {
    const kv = makeFakeKv();
    kv.store.set(cooldownKey("pr-review", "acme/widgets", "pr-7"), "not-json");
    const verdict = await checkAndArmCooldown({
      ...base,
      kv: kv.binding,
      executionId: "exec-2",
      now: 1_000_000,
    });
    expect(verdict).toEqual({ state: "armed" });
  });
});
