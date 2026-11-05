import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compileObjectKey } from "./compile-cache.ts";
import { memoryLedgers, type CacheLedgers } from "./ledger.ts";
import { manifestPath, objectPrefix, type Bucket, type Manifest } from "./manifest.ts";
import { executionNamespace, protectedCloud, pullRequestNamespace } from "./namespaces.ts";
import { SWEEP_STATE_KEY, sweepCache } from "./sweep.ts";
import { emptyBucket, REPO, startMiniflare } from "./support.test-support.ts";

const DAY = 24 * 3600 * 1000;
let mf: Awaited<ReturnType<typeof startMiniflare>>;
let bucket: Bucket;
beforeAll(async () => {
  mf = await startMiniflare();
  bucket = mf.bucket;
});
afterAll(async () => mf?.mf.dispose());
beforeEach(async () => emptyBucket(bucket));

const NOW = Date.now();
const key = (n: number) => n.toString(16).padStart(64, "0");

/** Writes a committed entry whose objects total `bytes` and whose last read was `lastReadAt`. */
const entry = async (namespace: string, n: number, lastReadAt: number, bytes = 10) => {
  const path = `${objectPrefix(namespace, key(n), "e", 1)}obj`;
  await bucket.put(path, "x".repeat(bytes));
  const manifest = {
    key: key(n),
    namespace,
    objects: [{ path, size: bytes, sha256: "0".repeat(64) }],
  } as unknown as Manifest;
  await bucket.put(manifestPath(namespace, key(n)), JSON.stringify(manifest), {
    customMetadata: { last_read_at: String(lastReadAt) },
  });
  return path;
};
const exists = async (k: string) => (await bucket.head(k)) !== null;
const options = (ledgers: CacheLedgers, closed: Record<number, number> = {}) => ({
  ledgers,
  pullRequestClosedAt: async (_repo: string, n: number) => closed[n] ?? null,
});

describe("cache sweep", () => {
  it("FD-CACHE-062 deletes every entry last read more than the TTL ago", async () => {
    const stale = await entry(protectedCloud(REPO), 1, NOW - 15 * DAY);
    const fresh = await entry(protectedCloud(REPO), 2, NOW - 13 * DAY);
    await bucket.put(compileObjectKey(protectedCloud(REPO), "cc"), "y");
    const r = await sweepCache(bucket, NOW, options(memoryLedgers()));
    expect(await exists(stale)).toBe(false);
    expect(await exists(manifestPath(protectedCloud(REPO), key(1)))).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(r.expired).toBe(1);
    const later = await sweepCache(bucket, NOW + 15 * DAY, options(memoryLedgers()));
    expect(await exists(compileObjectKey(protectedCloud(REPO), "cc"))).toBe(false);
    expect(later.expired).toBeGreaterThanOrEqual(2);
  });

  it("FD-CACHE-063 an over-bound repository loses its oldest entries down to 90% and the ledger is measured", async () => {
    const ledgers = memoryLedgers();
    for (let i = 0; i < 10; i++) await entry(protectedCloud(REPO), i, NOW - (10 - i) * 1000, 100);
    const r = await sweepCache(bucket, NOW, { ...options(ledgers), repoBoundBytes: 950 });
    expect(r.evicted).toBe(2);
    expect(r.measured[REPO]).toBe(800);
    expect(await exists(manifestPath(protectedCloud(REPO), key(0)))).toBe(false);
    expect(await exists(manifestPath(protectedCloud(REPO), key(1)))).toBe(false);
    expect(await exists(manifestPath(protectedCloud(REPO), key(2)))).toBe(true);
    expect((await ledgers(REPO).usage()).stored).toBe(800);
  });

  it("FD-CACHE-064 deletes a pull request's namespace once it has been closed for the delay", async () => {
    const open = await entry(pullRequestNamespace(REPO, 1), 1, NOW);
    const justClosed = await entry(pullRequestNamespace(REPO, 2), 2, NOW);
    const closed = await entry(pullRequestNamespace(REPO, 3), 3, NOW);
    await bucket.put(compileObjectKey(pullRequestNamespace(REPO, 3), "cc"), "y");
    const r = await sweepCache(bucket, NOW, options(memoryLedgers(), { 2: NOW - 23 * 3600 * 1000, 3: NOW - 25 * 3600 * 1000 }));
    expect([await exists(open), await exists(justClosed), await exists(closed)]).toEqual([true, true, false]);
    expect(await exists(compileObjectKey(pullRequestNamespace(REPO, 3), "cc"))).toBe(false);
    expect(r.closedPullRequests).toBe(2);
  });

  it("FD-CACHE-065 deletes an exec/ namespace 7 days after its creation", async () => {
    const ns = executionNamespace(REPO, "rehearsal-1");
    const path = await entry(ns, 1, NOW);
    expect((await sweepCache(bucket, NOW + 6 * DAY, { ...options(memoryLedgers()), ttlMs: 30 * DAY })).expired).toBe(0);
    await sweepCache(bucket, NOW + 8 * DAY, { ...options(memoryLedgers()), ttlMs: 30 * DAY });
    expect(await exists(path)).toBe(false);
  });

  it("FD-CACHE-066 deletes objects no committed manifest lists once older than 24 h", async () => {
    const listed = await entry(protectedCloud(REPO), 1, NOW);
    const stray = `${objectPrefix(protectedCloud(REPO), key(1), "late", 2)}obj`;
    const torn = `${objectPrefix(protectedCloud(REPO), key(9), "torn", 1)}obj`;
    await bucket.put(stray, "z");
    await bucket.put(torn, "z");
    await sweepCache(bucket, NOW + 23 * 3600 * 1000, options(memoryLedgers()));
    expect([await exists(stray), await exists(torn)]).toEqual([true, true]);
    const r = await sweepCache(bucket, NOW + 25 * 3600 * 1000, options(memoryLedgers()));
    expect([await exists(listed), await exists(stray), await exists(torn)]).toEqual([true, false, false]);
    expect(r.orphaned).toBe(2);
  });

  it("FD-CACHE-067 lists at most the page bound per run and resumes after the key it persists", async () => {
    // 1000 objects per page: two pages of committed entries.
    for (let i = 0; i < 550; i++) await entry(protectedCloud(REPO), i, NOW - 20 * DAY, 1);
    const first = await sweepCache(bucket, NOW, { ...options(memoryLedgers()), maxPages: 1 });
    expect(first.truncated).toBe(true);
    expect((await bucket.head(SWEEP_STATE_KEY))?.customMetadata?.start_after).toMatch(/^cache\//);
    let ticks = 1;
    for (let r = first; r.truncated; ticks++) r = await sweepCache(bucket, NOW, { ...options(memoryLedgers()), maxPages: 1 });
    expect(ticks).toBeGreaterThan(2);
    expect(await bucket.head(SWEEP_STATE_KEY)).toBeNull();
    expect((await bucket.list({ prefix: "cache/" })).objects).toHaveLength(0);
  }, 120_000);
});
