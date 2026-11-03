// The compile-cache route served by workerd through Miniflare, with the `CacheLedger` Durable Object per repository,
// and in Node against the same bucket for the clock-dependent cases.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compileObjectKey, handleCompileCache } from "./compile-cache.ts";
import { signCompileCacheToken, verifyCompileCacheToken } from "./compile-cache-token.ts";
import { memoryLedgers, MiB } from "./ledger.ts";
import { leaseCacheFields } from "./lease.ts";
import type { Bucket } from "./manifest.ts";
import { protectedCloud, pullRequestNamespace } from "./namespaces.ts";
import { emptyBucket, REPO, SECRET, startMiniflare } from "./support.test-support.ts";

let mf: Awaited<ReturnType<typeof startMiniflare>>;
let bucket: Bucket;
beforeAll(async () => {
  mf = await startMiniflare();
  bucket = mf.bucket;
});
afterAll(async () => mf?.mf.dispose());
beforeEach(async () => emptyBucket(bucket));

/**
 * The bucket through Miniflare's Node proxy, which stores a stream only when its length is known; workerd's request
 * body carries its length, a Node `Request` body does not, so the Node-side cases buffer it.
 */
const buffered = (): Bucket => ({
  ...bucket,
  head: (k) => bucket.head(k),
  get: ((k: string) => bucket.get(k)) as Bucket["get"],
  list: (o) => bucket.list(o),
  delete: (k) => bucket.delete(k),
  put: (async (k: string, v: unknown, o?: R2PutOptions) =>
    bucket.put(k, v instanceof ReadableStream ? await new Response(v).arrayBuffer() : (v as string), o)) as Bucket["put"],
});

const PR = pullRequestNamespace(REPO, 7);
const BASE = protectedCloud(REPO);
const token = (over: Partial<Parameters<typeof signCompileCacheToken>[1]> = {}) =>
  signCompileCacheToken(SECRET, {
    repo: REPO,
    executionId: "exec-pr",
    epoch: 1,
    read: [PR, BASE, "cas"],
    write: PR,
    expiresAt: Date.now() + 3_600_000,
    ...over,
  });
const req = (path: string, method: string, bearer: string | null, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  mf.mf.dispatchFetch(`http://x/v1/compile-cache/${path}`, {
    ...init,
    method,
    headers: { ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), ...init.headers },
  } as never);

describe("compile-cache route", () => {
  it("FD-CACHE-056 serves GET, HEAD, PUT, PROPFIND Depth 0 and MKCOL", async () => {
    const t = await token();
    expect((await req("acme/widgets/a/b/", "MKCOL", t)).status).toBe(201);
    expect((await req("acme/widgets/a/b/", "PROPFIND", t, { headers: { depth: "0" } })).status).toBe(207);
    expect((await req("acme/widgets/a/b/", "PROPFIND", t, { headers: { depth: "1" } })).status).toBe(403);
    expect((await req("acme/widgets/a/b/obj", "GET", t)).status).toBe(404);
    const body = "x".repeat(1000);
    const put = await req("acme/widgets/a/b/obj", "PUT", t, { body, headers: { "content-length": "1000" } });
    expect(put.status).toBe(201);
    const got = await req("acme/widgets/a/b/obj", "GET", t);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe(body);
    expect((await req("acme/widgets/a/b/obj", "HEAD", t)).headers.get("content-length")).toBe("1000");
    const stat = await req("acme/widgets/a/b/obj", "PROPFIND", t, { headers: { depth: "0" } });
    expect(await stat.text()).toContain("<D:getcontentlength>1000</D:getcontentlength>");
  });

  it("FD-CACHE-056 streams a body larger than one chunk through to R2 and back", async () => {
    const t = await token();
    const size = 8 * MiB;
    const bytes = new Uint8Array(size).map((_, i) => i % 251);
    expect((await req("acme/widgets/big", "PUT", t, { body: bytes, headers: { "content-length": String(size) } })).status).toBe(201);
    const back = new Uint8Array(await (await req("acme/widgets/big", "GET", t)).arrayBuffer());
    expect(back.length).toBe(size);
    expect(back[size - 1]).toBe((size - 1) % 251);
  });

  it("FD-CACHE-057 the token binds repository, execution, epoch, namespaces and an expiry no later than deadline_at", async () => {
    const fields = await leaseCacheFields(
      { repo: "Acme/Widgets", executionId: "exec-pr", class: "interactive", constraints: [], trigger: { _tag: "PullRequest", number: 7 } },
      { epoch: 3, executorKind: "cloudflare", deadlineAt: 5_000 },
      { publicOrigin: "https://ci.example.com/", tokenSecret: SECRET },
    );
    expect(fields.upload_grant.compile_cache?.endpoint).toBe("https://ci.example.com/v1/compile-cache/acme/widgets");
    const v = await verifyCompileCacheToken(SECRET, REPO, fields.upload_grant.compile_cache!.token, 4_999);
    expect(v).toEqual({
      ok: true,
      scope: { repo: REPO, executionId: "exec-pr", epoch: 3, read: [PR, BASE, "cas"], write: PR, expiresAt: 5_000 },
    });
    expect(await verifyCompileCacheToken(SECRET, REPO, fields.upload_grant.compile_cache!.token, 5_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("FD-CACHE-058 the namespaces come from the token, never from the path or headers", async () => {
    const base = await token({ executionId: "exec-main", read: [BASE], write: BASE });
    await req("acme/widgets/k", "PUT", base, { body: "base", headers: { "content-length": "4" } });
    const pr = await token();
    // The PR reads the base entry, then writes its own namespace; the base reader never sees the PR's write.
    expect(await (await req("acme/widgets/k", "GET", pr)).text()).toBe("base");
    await req("acme/widgets/k", "PUT", pr, { body: "pr!!", headers: { "content-length": "4", "x-namespace": BASE } });
    expect(await (await req("acme/widgets/k", "GET", pr)).text()).toBe("pr!!");
    expect(await (await req("acme/widgets/k", "GET", base)).text()).toBe("base");
    expect(await bucket.head(compileObjectKey(PR, "k"))).not.toBeNull();
    // A path that names a namespace is just a key below the repository.
    await req("acme/widgets/protected/acme/widgets/cloud/k", "PUT", pr, { body: "x", headers: { "content-length": "1" } });
    expect(await bucket.head(compileObjectKey(BASE, "protected/acme/widgets/cloud/k"))).toBeNull();
  });

  it("FD-CACHE-059 a missing, expired, malformed, forged or other-repository token is 403 and touches no object", async () => {
    const other = await token({ repo: "acme/other" });
    const expired = await token({ expiresAt: Date.now() - 1 });
    const forged = await signCompileCacheToken("wrong-secret", { repo: REPO, executionId: "e", epoch: 1, read: [BASE], write: BASE, expiresAt: Date.now() + 60_000 });
    for (const t of [null, expired, "cc3.garbage", forged, other]) {
      const r = await req("acme/widgets/k", "PUT", t, { body: "x", headers: { "content-length": "1" } });
      expect(r.status).toBe(403);
      expect((await req("acme/widgets/k", "GET", t)).status).toBe(403);
    }
    expect((await bucket.list()).objects).toHaveLength(0);
  });

  it("FD-CACHE-053 FD-CACHE-054 a PUT over 100 MiB is 413 and one past the ledger's bound is 507", async () => {
    const t = await token({ executionId: "exec-big" });
    const huge = await handleCompileCache(
      new Request("http://x/v1/compile-cache/acme/widgets/huge", {
        method: "PUT",
        headers: { authorization: `Bearer ${t}`, "content-length": String(100 * MiB + 1) },
      }),
      { bucket: buffered(), ledgers: memoryLedgers(), secret: SECRET, now: Date.now },
    );
    expect(huge?.status).toBe(413);
    const handled = await handleCompileCache(
      new Request("http://x/v1/compile-cache/acme/widgets/k", { method: "PUT", body: "xx", headers: { authorization: `Bearer ${t}`, "content-length": "2" } }),
      { bucket: buffered(), ledgers: memoryLedgers(), secret: SECRET, now: Date.now, bounds: { maxExecutionBytes: 1, maxRepoBytes: 10 } },
    );
    expect(handled?.status).toBe(507);
  });

  it("FD-CACHE-055 FD-CACHE-051 a terminal execution or an old epoch's token cannot write", async () => {
    const t = await token();
    const call = (lease: { epoch: number; terminal: boolean } | null) =>
      handleCompileCache(
        new Request("http://x/v1/compile-cache/acme/widgets/k", { method: "PUT", body: "x", headers: { authorization: `Bearer ${t}`, "content-length": "1" } }),
        { bucket: buffered(), ledgers: memoryLedgers(), secret: SECRET, now: Date.now, lease: async () => lease },
      );
    expect((await call({ epoch: 1, terminal: true }))?.status).toBe(403);
    expect((await call({ epoch: 2, terminal: false }))?.status).toBe(403);
    expect((await call({ epoch: 1, terminal: false }))?.status).toBe(201);
  });

  it("FD-CACHE-061 a GET of an object older than TTL/2 rewrites it, so its age restarts", async () => {
    await bucket.put(compileObjectKey(PR, "old"), "cached");
    const pending: Promise<unknown>[] = [];
    const later = Date.now() + 8 * 24 * 3600 * 1000;
    const before = (await bucket.head(compileObjectKey(PR, "old")))!.uploaded.getTime();
    const late = await signCompileCacheToken(SECRET, { repo: REPO, executionId: "exec-pr", epoch: 1, read: [PR], write: PR, expiresAt: later + 60_000 });
    const r = await handleCompileCache(
      new Request("http://x/v1/compile-cache/acme/widgets/old", { headers: { authorization: `Bearer ${late}` } }),
      {
        bucket,
        ledgers: memoryLedgers(),
        secret: SECRET,
        now: () => later,
        waitUntil: (p) => void pending.push(p),
        fixedLength: (s) => s,
      },
    );
    expect(await r?.text()).toBe("cached");
    await Promise.all(pending);
    expect(pending).toHaveLength(1);
    expect((await bucket.head(compileObjectKey(PR, "old")))!.uploaded.getTime()).toBeGreaterThanOrEqual(before);
  });
});
