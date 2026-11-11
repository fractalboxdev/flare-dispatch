import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GiB, makeCacheLedger, memoryStorage, MiB } from "./ledger.ts";
import { startMiniflare } from "./support.test-support.ts";

const reserve = (bytes: number, executionId = "e-1") => ({ executionId, bytes, expiresAt: 10_000 });

describe("CacheLedger", () => {
  it("[FD-CACHE-052] a reservation records the declared length before any write", async () => {
    const ledger = makeCacheLedger(memoryStorage());
    expect(await ledger.reserve(reserve(5 * MiB))).toEqual({ ok: true, repoBytes: 5 * MiB });
    expect(await ledger.usage()).toEqual({ stored: 0, pending: 5 * MiB });
    await ledger.commit({ executionId: "e-1", bytes: 5 * MiB });
    expect(await ledger.usage()).toEqual({ stored: 5 * MiB, pending: 0 });
  });

  it("[FD-CACHE-054] a reservation over 10 GiB per execution or 20 GiB per repository is refused", async () => {
    const ledger = makeCacheLedger(memoryStorage());
    expect((await ledger.reserve(reserve(10 * GiB))).ok).toBe(true);
    expect(await ledger.reserve(reserve(1))).toMatchObject({ ok: false, reason: "execution" });
    expect((await ledger.reserve(reserve(10 * GiB, "e-2"))).ok).toBe(true);
    expect(await ledger.reserve(reserve(1, "e-3"))).toMatchObject({ ok: false, reason: "repository" });
  });

  it("[FD-CACHE-055] a terminal execution's reservations are refused and its unused bytes released", async () => {
    const ledger = makeCacheLedger(memoryStorage());
    await ledger.reserve(reserve(300));
    await ledger.commit({ executionId: "e-1", bytes: 100 });
    expect(await ledger.end({ executionId: "e-1", expiresAt: 10_000 })).toEqual({ released: 200 });
    expect(await ledger.usage()).toEqual({ stored: 100, pending: 0 });
    expect(await ledger.reserve(reserve(1))).toMatchObject({ ok: false, reason: "ended" });
  });

  it("[FD-CACHE-063] the sweep's measure replaces the stored count and release subtracts deletions", async () => {
    const ledger = makeCacheLedger(memoryStorage());
    await ledger.reserve({ ...reserve(1000), immediate: true });
    expect(await ledger.release({ bytes: 400, nowMs: 0 })).toBe(600);
    expect(await ledger.measure({ bytes: 50, nowMs: 0 })).toBe(50);
  });
});

describe("CacheLedger Durable Object on workerd", () => {
  let mf: Awaited<ReturnType<typeof startMiniflare>>;
  beforeAll(async () => {
    mf = await startMiniflare();
  });
  afterAll(async () => mf?.mf.dispose());

  const call = async (repo: string, op: string, body: unknown) =>
    (await mf.mf.dispatchFetch(`http://x/ledger/${encodeURIComponent(repo)}/${op}`, {
      method: "POST",
      body: JSON.stringify(body),
    })).json();

  it("[FD-CACHE-052] [FD-CACHE-054] one object per repository holds the bounds across calls", async () => {
    expect(await call("acme/a", "reserve", reserve(20 * GiB, "x"))).toMatchObject({ ok: false, reason: "execution" });
    expect(await call("acme/a", "reserve", reserve(6 * GiB, "x"))).toMatchObject({ ok: true });
    expect(await call("acme/a", "reserve", reserve(6 * GiB, "y"))).toMatchObject({ ok: true });
    expect(await call("acme/a", "reserve", reserve(9 * GiB, "z"))).toMatchObject({ ok: false, reason: "repository" });
    // Another repository's ledger is another object.
    expect(await call("acme/b", "reserve", reserve(9 * GiB, "z"))).toMatchObject({ ok: true });
  });
});
