import { describe, expect, it } from "vitest";
import {
  checkAndArmCooldown,
  cooldownKey,
  resolveCooldownSeconds,
} from "./cooldown";
import { makeFakeKv } from "./test-helpers";

const COOLDOWN = {
  seconds: 1800,
  secondsKey: "pr-review.cooldown-seconds",
  scope: (input: unknown) => `pr-${(input as { pr: number }).pr}`,
};

const base = {
  runName: "pr-review",
  cooldown: COOLDOWN,
  repo: "acme/widgets",
  inputs: { pr: 7 },
} as const;

describe("resolveCooldownSeconds", () => {
  it("returns the default when no key, no CONFIG_KV, or key unset", async () => {
    const config = makeFakeKv();
    expect(await resolveCooldownSeconds(3600, undefined, config.binding)).toBe(3600);
    expect(await resolveCooldownSeconds(3600, "pr-review.cooldown-seconds", undefined)).toBe(
      3600,
    );
    expect(
      await resolveCooldownSeconds(3600, "pr-review.cooldown-seconds", config.binding),
    ).toBe(3600);
  });

  it("uses a valid CONFIG_KV override, clamped to [60, 86400]", async () => {
    const config = makeFakeKv();
    config.store.set("pr-review.cooldown-seconds", "900");
    expect(
      await resolveCooldownSeconds(3600, "pr-review.cooldown-seconds", config.binding),
    ).toBe(900);
    config.store.set("pr-review.cooldown-seconds", "30");
    expect(
      await resolveCooldownSeconds(3600, "pr-review.cooldown-seconds", config.binding),
    ).toBe(60);
    config.store.set("pr-review.cooldown-seconds", "999999");
    expect(
      await resolveCooldownSeconds(3600, "pr-review.cooldown-seconds", config.binding),
    ).toBe(86_400);
  });

  it("falls back to default on junk values", async () => {
    const config = makeFakeKv();
    for (const junk of ["", "nope", "0", "-5"]) {
      config.store.set("pr-review.cooldown-seconds", junk);
      expect(
        await resolveCooldownSeconds(3600, "pr-review.cooldown-seconds", config.binding),
      ).toBe(3600);
    }
  });
});

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

  it("honours CONFIG_KV secondsKey override for the cooling window", async () => {
    const kv = makeFakeKv();
    const config = makeFakeKv();
    // 10-minute window via CONFIG_KV (default on the run is 1800).
    config.store.set("pr-review.cooldown-seconds", "600");
    await checkAndArmCooldown({
      ...base,
      kv: kv.binding,
      configKv: config.binding,
      executionId: "exec-1",
      now: 1_000_000,
    });
    // 11 min later — past the 10-min override, still inside the 30-min default.
    const verdict = await checkAndArmCooldown({
      ...base,
      kv: kv.binding,
      configKv: config.binding,
      executionId: "exec-2",
      now: 1_000_000 + 11 * 60 * 1000,
    });
    expect(verdict).toEqual({ state: "armed" });
  });
});
