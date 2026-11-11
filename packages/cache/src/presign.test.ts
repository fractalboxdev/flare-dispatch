// The presigner policy runs against the fake presigner, since Miniflare has no S3 endpoint; the SigV4 signer is
// checked against AWS's published presigned-URL example. A real R2 bucket honouring the signed `Content-Length`
// is not exercised here.
import { ObjectStorePresigner } from "@fractalboxdev/mameko-ports";
import { Effect, Exit, Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "./crypto.ts";
import { GiB } from "./ledger.ts";
import { CacheClock } from "./lease.ts";
import { commitCacheManifest, objectPrefix, readManifest, type Bucket } from "./manifest.ts";
import { protectedCloud, pullRequestNamespace } from "./namespaces.ts";
import {
  MAX_URL_LIFETIME_MS,
  ObjectStorePresignerLive,
  presignForExecution,
  R2PresignerLive,
} from "./presign.ts";
import { presignV4 } from "./sigv4.ts";
import {
  EXEC,
  emptyBucket,
  failureOf,
  layers,
  lease,
  REPO,
  signerFor,
  signingKeys,
  startMiniflare,
  world,
  type World,
} from "./support.test-support.ts";

const KEY = "f".repeat(64);
const NS = pullRequestNamespace(REPO, 7);
type ObjectRequest = { key: string; method: "GET" | "PUT"; length: number | null };
const put = (key: string, length: number | null): ObjectRequest => ({ key, method: "PUT", length });
const get = (key: string): ObjectRequest => ({ key, method: "GET", length: null });
const own = (file: string, epoch = 2) => `${objectPrefix(NS, KEY, EXEC, epoch)}${file}`;

let mf: Awaited<ReturnType<typeof startMiniflare>>;
let bucket: Bucket;
let keys: Awaited<ReturnType<typeof signingKeys>>;
beforeAll(async () => {
  mf = await startMiniflare();
  bucket = mf.bucket;
  keys = await signingKeys();
});
afterAll(async () => mf?.mf.dispose());
beforeEach(async () => emptyBucket(bucket));

const presign = (w: World, objects: ObjectRequest[], epoch = 2) =>
  Effect.runPromiseExit(
    presignForExecution({ execution_id: EXEC, epoch, objects }).pipe(
      Effect.provide(layers(w, bucket, signerFor(keys.pair.privateKey))),
    ),
  );
const answer = async (p: Promise<Exit.Exit<unknown, unknown>>) => {
  const exit = await p;
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
  return exit.value as { urls?: { key: string; url: string; expires_at: number }[]; status?: string };
};

describe("SigV4 presigning", () => {
  it("[FD-CACHE-091] signs AWS's published presigned GET example", async () => {
    const url = await presignV4({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      amzDate: "20130524T000000Z",
      expiresSec: 86400,
    });
    expect(url).toContain(
      "X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("[FD-CACHE-091] [FD-CACHE-048] [FD-CACHE-049] the live signer uses the account's S3 endpoint, one key, one method and signs a PUT's length", async () => {
    const live = R2PresignerLive({ accountId: "0123abcd", bucket: "cache", accessKeyId: "AK", secretAccessKey: "SK" }).pipe(
      Layer.provide(Layer.succeed(CacheClock, { now: () => Date.UTC(2026, 0, 1) })),
    );
    const port = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* ObjectStorePresigner;
      }).pipe(Effect.provide(ObjectStorePresignerLive.pipe(Layer.provide(live)))),
    );
    const at = Date.UTC(2026, 0, 1);
    const signed = await Effect.runPromise(port.presign("cache/a b/c", "PUT", 42, at + 600_000));
    const url = new URL(signed.url);
    expect(url.host).toBe("0123abcd.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/cache/cache/a%20b/c");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;host");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-Credential")).toBe("AK/20260101/auto/s3/aws4_request");
    const getUrl = new URL((await Effect.runPromise(port.presign("k", "GET", null, at + 60_000))).url);
    expect(getUrl.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });
});

describe("presign policy", () => {
  it("[FD-CACHE-048] a URL expires at the earlier of 15 min after minting and deadline_at", async () => {
    const w = world();
    const late = await answer(presign(w, [put(own("a"), 10)]));
    expect(late.urls?.[0]?.expires_at).toBe(w.now + MAX_URL_LIFETIME_MS);
    const soon = world([lease({ deadlineAt: 1_000_000 + 60_000 })]);
    expect((await answer(presign(soon, [put(own("a"), 10)]))).urls?.[0]?.expires_at).toBe(1_060_000);
    expect(w.signed[0]).toMatchObject({ key: own("a"), method: "PUT", length: 10 });
  });

  it("[FD-CACHE-049] a PUT URL only under the writable namespace and current epoch, with its declared length", async () => {
    const w = world();
    for (const key of [
      `${objectPrefix(protectedCloud(REPO), KEY, EXEC, 2)}a`,
      own("a", 1),
      `${objectPrefix(NS, KEY, "exec-other", 2)}a`,
      `artifacts/${EXEC}/2/x`,
    ])
      expect(failureOf(await presign(w, [put(key, 1)]))).toMatchObject({ status: 403 });
    expect(failureOf(await presign(w, [put(own("a"), null)]))).toMatchObject({ status: 411 });
    expect((await answer(presign(w, [put(own("a"), 7)]))).urls).toHaveLength(1);
  });

  it("[FD-CACHE-050] a GET URL only for an object a committed manifest of a readable namespace lists", async () => {
    const writer = world([lease({ namespaces: { read: [], write: protectedCloud(REPO) } })]);
    const path = `${objectPrefix(protectedCloud(REPO), KEY, EXEC, 2)}a`;
    await bucket.put(path, "x");
    expect(failureOf(await presign(world(), [get(path)]))).toMatchObject({ status: 404 });
    await Effect.runPromise(
      commitCacheManifest({
        execution_id: EXEC,
        epoch: 2,
        manifest: { key: KEY, namespace: protectedCloud(REPO), objects: [{ path, size: 1, sha256: await sha256Hex("x") }] },
      }).pipe(Effect.provide(layers(writer, bucket, signerFor(keys.pair.privateKey)))),
    );
    expect((await answer(presign(world(), [get(path)]))).urls).toHaveLength(1);
    // A reader without the namespace gets nothing.
    const outsider = world([lease({ namespaces: { read: [NS], write: NS } })]);
    expect(failureOf(await presign(outsider, [get(path)]))).toMatchObject({ status: 403 });
    // An object the manifest does not list gets nothing.
    expect(failureOf(await presign(world(), [get(`${objectPrefix(protectedCloud(REPO), KEY, EXEC, 2)}b`)]))).toMatchObject({ status: 404 });
  });

  it("[FD-CACHE-061] a GET of an entry last read over TTL/2 ago refreshes last_read_at", async () => {
    const writer = world([lease({ namespaces: { read: [], write: protectedCloud(REPO) } })]);
    const path = `${objectPrefix(protectedCloud(REPO), KEY, EXEC, 2)}a`;
    await bucket.put(path, "x");
    await Effect.runPromise(
      commitCacheManifest({ execution_id: EXEC, epoch: 2, manifest: { key: KEY, namespace: protectedCloud(REPO), objects: [{ path, size: 1, sha256: await sha256Hex("x") }] } }).pipe(
        Effect.provide(layers(writer, bucket, signerFor(keys.pair.privateKey))),
      ),
    );
    const reader = world([lease({ deadlineAt: Number.MAX_SAFE_INTEGER })]);
    reader.now += 8 * 24 * 3600 * 1000;
    await answer(presign(reader, [get(path)]));
    expect((await Effect.runPromise(readManifest(bucket, protectedCloud(REPO), KEY)))?.lastReadAt).toBe(reader.now);
  });

  it("[FD-CACHE-051] a URL request carrying an old epoch is stale and mints nothing", async () => {
    const w = world();
    expect(await answer(presign(w, [put(own("a", 1), 1)], 1))).toEqual({ status: "stale" });
    expect(w.signed).toHaveLength(0);
  });

  it("[FD-CACHE-052] [FD-CACHE-054] each PUT reserves its length first and a reservation over a bound is 507", async () => {
    const w = world();
    await answer(presign(w, [put(own("a"), 3 * GiB), put(own("b"), 3 * GiB)]));
    expect(await w.ledgers(REPO).usage()).toEqual({ stored: 0, pending: 6 * GiB });
    expect(failureOf(await presign(w, [put(own("c"), 4 * GiB), put(own("d"), 1)]))).toMatchObject({ status: 507 });
    expect(w.signed).toHaveLength(2);
  });

  it("[FD-CACHE-053] an object over 4 GiB is refused with 413", async () => {
    const w = world();
    expect(failureOf(await presign(w, [put(own("a"), 4 * GiB + 1)]))).toMatchObject({ status: 413 });
    expect(await w.ledgers(REPO).usage()).toEqual({ stored: 0, pending: 0 });
  });

  it("[FD-CACHE-055] after the execution is terminal every write request is 403", async () => {
    const w = world([lease({ status: "terminal" })]);
    expect(failureOf(await presign(w, [put(own("a"), 1)]))).toMatchObject({ status: 403 });
  });

  it("[FD-CACHE-008] a confidential-compute repository gets no L2 URL", async () => {
    const w = world([lease({ confidential: true })]);
    expect(failureOf(await presign(w, [put(own("a"), 1)]))).toMatchObject({ status: 403 });
  });

  it("[FD-CACHE-047] a log segment of this epoch gets a PUT URL and reserves no cache bytes", async () => {
    const w = world();
    const key = `logs/${EXEC}/2/${"0".repeat(24)}/stdout-0-10.ndjson`;
    expect((await answer(presign(w, [put(key, 10)]))).urls?.[0]?.url).toMatch(/^fake:\/\/PUT\/logs\//);
    expect(failureOf(await presign(w, [put(`logs/${EXEC}/1/${"0".repeat(24)}/stdout-0-10.ndjson`, 10)]))).toMatchObject({ status: 403 });
    expect(await w.ledgers(REPO).usage()).toEqual({ stored: 0, pending: 0 });
  });
});
