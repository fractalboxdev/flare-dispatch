// The device's compile-cache proxy in front of the real compile-cache route on Miniflare's R2. The socket the device
// extension serves it on, and sccache inside a job sandbox, are not run here.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compileObjectKey, handleCompileCache } from "../compile-cache.ts";
import { signCompileCacheToken } from "../compile-cache-token.ts";
import { memoryLedgers } from "../ledger.ts";
import type { Bucket } from "../manifest.ts";
import { protectedCloud, pullRequestNamespace } from "../namespaces.ts";
import { emptyBucket, REPO, SECRET, signingKeys, startMiniflare } from "../support.test-support.ts";
import { compileCacheProxy } from "./compile-cache-proxy.ts";
import { memoryDisk, openL1 } from "./l1.ts";

const PR = pullRequestNamespace(REPO, 7);
const BASE = protectedCloud(REPO);
let mf: Awaited<ReturnType<typeof startMiniflare>>;
let bucket: Bucket;
beforeAll(async () => {
  mf = await startMiniflare();
  bucket = mf.bucket;
});
afterAll(async () => mf?.mf.dispose());
beforeEach(async () => emptyBucket(bucket));

/** Miniflare's Node proxy stores a stream only with a known length, so the route's writes are buffered here. */
const buffered = (): Bucket => ({
  ...bucket,
  head: (k) => bucket.head(k),
  get: ((k: string) => bucket.get(k)) as Bucket["get"],
  list: (o) => bucket.list(o),
  delete: (k) => bucket.delete(k),
  put: (async (k: string, v: unknown, o?: R2PutOptions) =>
    bucket.put(k, v instanceof ReadableStream ? await new Response(v).arrayBuffer() : (v as string), o)) as Bucket["put"],
});

/** A `200` whose body fails after the headers arrive, as on a connection reset mid-transfer. */
const brokenBody = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("connection reset"));
      },
    }),
    { status: 200 },
  );

const setup = async (opts: { read?: string[]; write?: string | null; down?: boolean; brokenBody?: boolean } = {}) => {
  const read = opts.read ?? [PR, BASE];
  const write = opts.write === undefined ? PR : opts.write;
  const token = await signCompileCacheToken(SECRET, { repo: REPO, executionId: "e-dev", epoch: 1, read, write, expiresAt: Date.now() + 60_000 });
  const calls: string[] = [];
  const keys = await signingKeys();
  const disk = memoryDisk(1_000_000);
  const l1 = await openL1({ disk, l2: { fetch: async () => null, upload: async () => undefined }, keys: { controlPlane: keys.publicJwk, device: () => null } });
  const proxy = compileCacheProxy({
    l1,
    read,
    write,
    upstream: { endpoint: "https://ci.example.com/v1/compile-cache/acme/widgets", token },
    fetch: (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      if (opts.down === true) throw new TypeError("network down");
      if (opts.brokenBody === true) return brokenBody();
      return (await handleCompileCache(new Request(url, init), { bucket: buffered(), ledgers: memoryLedgers(), secret: SECRET, now: Date.now }))!;
    }) as typeof fetch,
  });
  const req = (path: string, method: string, body?: string) =>
    proxy(new Request(`http://proxy/${path}`, { method, ...(body === undefined ? {} : { body, headers: { "content-length": String(body.length) } }) }));
  return { req, proxy, calls, disk };
};

describe("device compile-cache proxy", () => {
  it("[FD-CACHE-060] serves a hit from L1 and forwards a miss to the route under the execution's token", async () => {
    await bucket.put(compileObjectKey(BASE, "k1"), "from-base");
    const { req, calls } = await setup();
    expect(await (await req("k1", "GET")).text()).toBe("from-base");
    expect(await (await req("k1", "GET")).text()).toBe("from-base");
    expect(calls).toEqual(["GET /v1/compile-cache/acme/widgets/k1"]);
    expect((await req("absent", "GET")).status).toBe(404);
  });

  it("[FD-CACHE-060] a write goes to the route's writable namespace and then to L1; MKCOL and PROPFIND Depth 0 answer locally for collections", async () => {
    const { req, calls } = await setup();
    expect((await req("a/", "MKCOL")).status).toBe(201);
    expect((await req("a/", "PROPFIND")).status).toBe(207);
    expect((await req("a/obj", "PUT", "data")).status).toBe(201);
    expect(await (await bucket.get(compileObjectKey(PR, "a/obj")))!.text()).toBe("data");
    expect(await (await req("a/obj", "GET")).text()).toBe("data");
    expect(calls).toEqual(["PUT /v1/compile-cache/acme/widgets/a/obj"]);
  });

  it("[FD-CACHE-060] an L1 copy is filed only under the namespace that answered, so a pull request's object never answers a protected reader", async () => {
    await bucket.put(compileObjectKey(PR, "k"), "pr-object");
    const pr = await setup();
    expect(await (await pr.req("k", "GET")).text()).toBe("pr-object");
    expect([...pr.disk.files.keys()].every((p) => p.startsWith(`${PR}/`))).toBe(true);
    const base = await setup({ read: [BASE], write: BASE });
    expect((await base.req("k", "GET")).status).toBe(404);
  });

  it("[FD-CACHE-060] [FD-CACHE-011] an unreachable route is a miss, a write without a writable namespace is refused, and an object over 100 MiB is 413", async () => {
    const down = await setup({ down: true });
    expect((await down.req("k", "GET")).status).toBe(404);
    const readOnly = await setup({ write: null });
    expect((await readOnly.req("k", "PUT", "x")).status).toBe(403);
    const { req, proxy, calls } = await setup();
    expect((await req("k", "PUT")).status).toBe(411);
    const huge = await proxy(
      new Request("http://proxy/k", { method: "PUT", headers: { "content-length": String(100 * 1024 * 1024 + 1) } }),
    );
    expect(huge.status).toBe(413);
    expect(calls).toEqual([]);
    expect((await req("../etc/passwd", "GET")).status).toBe(404);
  });

  it("[FD-CACHE-011] a GET whose body fails after the route answered 200 is a miss, and L1 keeps nothing", async () => {
    const { req, disk } = await setup({ brokenBody: true });
    expect((await req("k", "GET")).status).toBe(404);
    expect(disk.files.size).toBe(0);
  });
});
