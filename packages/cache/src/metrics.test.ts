import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileObjectKey, handleCompileCache, type CompileCacheLookup } from "./compile-cache.ts";
import { signCompileCacheToken } from "./compile-cache-token.ts";
import { memoryLedgers } from "./ledger.ts";
import {
  CACHE_LOOKUP_SCHEMA,
  cacheHitRates,
  compileCacheLookupRow,
  executionCacheColumns,
  HIT_RATE_WINDOW_MS,
  recordCacheLookups,
  type CacheLookup,
} from "./metrics.ts";
import { protectedCloud, pullRequestNamespace } from "./namespaces.ts";
import { REPO, SECRET, startMiniflare } from "./support.test-support.ts";

let mf: Awaited<ReturnType<typeof startMiniflare>>;
beforeAll(async () => {
  mf = await startMiniflare();
  for (const s of CACHE_LOOKUP_SCHEMA) await mf.db.prepare(s).run();
});
afterAll(async () => mf?.mf.dispose());

const NOW = 2_000_000_000_000;
const row = (over: Partial<CacheLookup>): CacheLookup => ({
  executionId: "e-1",
  executorKind: "cloudflare",
  level: "L2",
  tier: "protected-cloud",
  hit: true,
  bytes: 100,
  at: NOW - 1000,
  ...over,
});

describe("cache measurement", () => {
  it("FD-CACHE-090 the compile-cache route reports each GET's hit or miss and the namespace that answered", async () => {
    const seen: CompileCacheLookup[] = [];
    await mf.bucket.put(compileObjectKey(protectedCloud(REPO), "hit"), "abc");
    const token = await signCompileCacheToken(SECRET, {
      repo: REPO,
      executionId: "e-cc",
      epoch: 1,
      read: [pullRequestNamespace(REPO, 7), protectedCloud(REPO)],
      write: pullRequestNamespace(REPO, 7),
      expiresAt: Date.now() + 60_000,
    });
    const get = (k: string) =>
      handleCompileCache(new Request(`http://x/v1/compile-cache/acme/widgets/${k}`, { headers: { authorization: `Bearer ${token}` } }), {
        bucket: mf.bucket,
        ledgers: memoryLedgers(),
        secret: SECRET,
        now: Date.now,
        onLookup: (l) => void seen.push(l),
      });
    const hit = await get("hit");
    expect(hit?.headers.get("x-cache-namespace")).toBe(protectedCloud(REPO));
    await hit?.text();
    await get("miss");
    expect(seen).toEqual([
      { executionId: "e-cc", namespace: protectedCloud(REPO), hit: true, bytes: 3 },
      { executionId: "e-cc", namespace: null, hit: false, bytes: 0 },
    ]);
    await recordCacheLookups(mf.db, seen.map((l) => compileCacheLookupRow(l, "device", NOW - 10)));
    expect(await executionCacheColumns(mf.db, "e-cc")).toEqual([
      { level: "compile-cache", tier: null, lookups: 1, hits: 0, bytes_restored: 0 },
      { level: "compile-cache", tier: "protected-cloud", lookups: 1, hits: 1, bytes_restored: 3 },
    ]);
  });

  it("FD-CACHE-090 records each lookup's level, tier, hit and bytes, and reports the 28-day hit rate per tier and executor kind", async () => {
    await recordCacheLookups(mf.db, [
      row({}),
      row({ tier: "pull-request", bytes: 50 }),
      row({ tier: null, hit: false, bytes: 999 }),
      row({ tier: null, hit: false }),
      row({ executorKind: "device", level: "L1", tier: "protected-device" }),
      row({ at: NOW - HIT_RATE_WINDOW_MS - 1 }),
    ]);
    const rates = (await cacheHitRates(mf.db, NOW)).filter((r) => r.level === "L2");
    expect(rates).toEqual([
      { executor_kind: "cloudflare", level: "L2", tier: null, lookups: 4, hits: 0, hit_rate: 0, bytes_restored: 0 },
      { executor_kind: "cloudflare", level: "L2", tier: "protected-cloud", lookups: 4, hits: 1, hit_rate: 0.25, bytes_restored: 100 },
      { executor_kind: "cloudflare", level: "L2", tier: "pull-request", lookups: 4, hits: 1, hit_rate: 0.25, bytes_restored: 50 },
    ]);
    const device = (await cacheHitRates(mf.db, NOW)).find((r) => r.level === "L1");
    expect(device).toMatchObject({ executor_kind: "device", tier: "protected-device", hit_rate: 1 });
    expect(await executionCacheColumns(mf.db, "e-1")).toContainEqual({
      level: "L2",
      tier: "protected-cloud",
      lookups: 2,
      hits: 2,
      bytes_restored: 200,
    });
  });
});
