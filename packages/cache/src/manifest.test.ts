import { Effect, Exit, Layer, Logger, References } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "./crypto.ts";
import {
  CacheNamespaceDenied,
  commitCacheManifest,
  es256Sign,
  lookupEntry,
  manifestPath,
  objectPrefix,
  readManifest,
  refreshLastRead,
  restoreObjects,
  saveEntry,
  signedBody,
  type Bucket,
  type Manifest,
} from "./manifest.ts";
import { protectedCloud, pullRequestNamespace } from "./namespaces.ts";
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

const KEY = "d".repeat(64);
const NS = pullRequestNamespace(REPO, 7);
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

const upload = async (namespace: string, epoch: number, files: Record<string, string>, executionId = EXEC) => {
  const objects = [];
  for (const [name, body] of Object.entries(files)) {
    const path = `${objectPrefix(namespace, KEY, executionId, epoch)}${name}`;
    await bucket.put(path, body);
    objects.push({ path, size: new TextEncoder().encode(body).length, sha256: await sha256Hex(body) });
  }
  return objects;
};

const commit = (w: World, frame: { epoch: number; manifest: unknown }, devices: Record<string, string> = {}) =>
  Effect.runPromiseExit(
    commitCacheManifest({ execution_id: EXEC, ...frame }).pipe(
      Effect.provide(layers(w, bucket, signerFor(keys.pair.privateKey, devices))),
    ),
  );

const ok = async <A, E>(p: Promise<Exit.Exit<A, E>>) => {
  const exit = await p;
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
  return exit.value;
};

const fetchManifest = async (namespace: string, key: string) =>
  (await Effect.runPromise(readManifest(bucket, namespace, key)))?.manifest ?? null;
const verification = () => ({ controlPlane: keys.publicJwk, device: () => null });
const reader = { namespaces: { read: [NS, protectedCloud(REPO)], write: NS }, class: "interactive", constraints: [], executorKind: "cloudflare" };

describe("cache entries, commit and verification", () => {
  it("[FD-CACHE-039] [FD-CACHE-042] a commit records key, namespace, tier, writer, epoch, time and every object", async () => {
    const w = world();
    const objects = await upload(NS, 2, { "store.tar": "abc" });
    expect(await ok(commit(w, { epoch: 2, manifest: { key: KEY, namespace: NS, objects } }))).toBe("accepted");
    const read = await Effect.runPromise(readManifest(bucket, NS, KEY));
    expect(read?.manifest).toMatchObject({
      key: KEY,
      namespace: NS,
      tier: "pull-request",
      writer: { executor_id: "cf-1", executor_kind: "cloudflare", execution_id: EXEC, epoch: 2 },
      objects,
      created_at: w.now,
    });
    expect(read?.lastReadAt).toBe(w.now);
  });

  it("[FD-CACHE-039] a commit before every object is uploaded, or naming an object outside the epoch path, is refused", async () => {
    const w = world();
    const objects = await upload(NS, 2, { a: "1" });
    const missing = { path: `${objectPrefix(NS, KEY, EXEC, 2)}b`, size: 1, sha256: "e".repeat(64) };
    expect(Exit.isFailure(await commit(w, { epoch: 2, manifest: { key: KEY, namespace: NS, objects: [...objects, missing] } }))).toBe(true);
    const outside = await upload(NS, 1, { a: "1" });
    expect(Exit.isFailure(await commit(w, { epoch: 2, manifest: { key: KEY, namespace: NS, objects: outside } }))).toBe(true);
    expect(await bucket.head(manifestPath(NS, KEY))).toBeNull();
  });

  it("[FD-CACHE-040] [FD-CACHE-051] a commit at an epoch other than the current one is stale and creates no entry", async () => {
    const w = world();
    const objects = await upload(NS, 1, { a: "1" });
    expect(await ok(commit(w, { epoch: 1, manifest: { key: KEY, namespace: NS, objects } }))).toBe("stale");
    expect(await bucket.head(manifestPath(NS, KEY))).toBeNull();
  });

  it("[FD-CACHE-029] a commit to a namespace other than the writable one fails with CacheNamespaceDenied", async () => {
    const w = world();
    const objects = await upload(protectedCloud(REPO), 2, { a: "1" });
    const exit = await commit(w, { epoch: 2, manifest: { key: KEY, namespace: protectedCloud(REPO), objects } });
    expect(failureOf(exit)).toBeInstanceOf(CacheNamespaceDenied);
    expect(await bucket.head(manifestPath(protectedCloud(REPO), KEY))).toBeNull();
  });

  it("[FD-CACHE-055] a terminal execution's commit is refused with 403", async () => {
    const w = world([lease({ status: "terminal" })]);
    const objects = await upload(NS, 2, { a: "1" });
    const exit = await commit(w, { epoch: 2, manifest: { key: KEY, namespace: NS, objects } });
    expect(failureOf(exit)).toMatchObject({ _tag: "CommitRefused", status: 403 });
  });

  it("[FD-CACHE-041] the first committed manifest stays and a later commit for the key is answered duplicate (Miniflare R2)", async () => {
    const first = world();
    const objects = await upload(NS, 2, { a: "first" });
    expect(await ok(commit(first, { epoch: 2, manifest: { key: KEY, namespace: NS, objects } }))).toBe("accepted");
    const second = world([lease({ executionId: EXEC, epoch: 2, executorId: "cf-2" })]);
    second.now = 2_000_000;
    expect(await ok(commit(second, { epoch: 2, manifest: { key: KEY, namespace: NS, objects } }))).toBe("duplicate");
    expect((await fetchManifest(NS, KEY))?.writer.executor_id).toBe("cf-1");
    // The conditional put itself: `etagDoesNotMatch: "*"` answers null for an existing key.
    expect(await bucket.put(manifestPath(NS, KEY), "{}", { onlyIf: { etagDoesNotMatch: "*" } })).toBeNull();
  });

  it("[FD-CACHE-043] a device manifest needs a valid signature by the device's registered cache-entry key", async () => {
    const device = await signingKeys();
    const spki = Buffer.from(await crypto.subtle.exportKey("spki", device.pair.publicKey)).toString("base64");
    const w = world([lease({ executorId: "dev-1", executorKind: "device" })]);
    w.now = 5;
    const objects = await upload(NS, 2, { a: "1" });
    const body = {
      key: KEY,
      namespace: NS,
      tier: "pull-request" as const,
      writer: { executor_id: "dev-1", executor_kind: "device", execution_id: EXEC, epoch: 2 },
      objects,
      created_at: 5,
    };
    const forged = await es256Sign(keys.pair.privateKey, signedBody(body));
    expect(Exit.isFailure(await commit(w, { epoch: 2, manifest: { key: KEY, namespace: NS, objects, signature: forged } }, { "dev-1": spki }))).toBe(true);
    expect(Exit.isFailure(await commit(w, { epoch: 2, manifest: { key: KEY, namespace: NS, objects } }, { "dev-1": spki }))).toBe(true);
    const signature = await es256Sign(device.pair.privateKey, signedBody(body));
    expect(await ok(commit(w, { epoch: 2, manifest: { key: KEY, namespace: NS, objects, signature } }, { "dev-1": spki }))).toBe("accepted");
    const manifest = (await fetchManifest(NS, KEY))!;
    expect(manifest.signature.key_id).toBe("dev-1");
    expect(await Effect.runPromise(lookupEntry({ ...reader, executorKind: "device" }, KEY, fetchManifest, { controlPlane: keys.publicJwk, device: (id) => (id === "dev-1" ? spki : null) }))).not.toBeNull();
  });

  it("[FD-CACHE-044] objects without a committed manifest are a miss", async () => {
    await upload(NS, 2, { a: "1" });
    expect(await Effect.runPromise(lookupEntry(reader, KEY, fetchManifest, verification()))).toBeNull();
  });

  it("[FD-CACHE-045] a failed signature or object digest is a miss logged as cache.verify_failed", async () => {
    const w = world();
    const objects = await upload(NS, 2, { a: "1" });
    await ok(commit(w, { epoch: 2, manifest: { key: KEY, namespace: NS, objects } }));
    const other = await signingKeys();
    const logs: unknown[] = [];
    const logger = Effect.provide(
      Layer.succeed((await import("effect")).Logger.CurrentLoggers, new Set([(await import("effect")).Logger.make((o) => void logs.push(o.message))])),
    );
    const miss = await Effect.runPromise(
      lookupEntry(reader, KEY, fetchManifest, { controlPlane: other.publicJwk, device: () => null }).pipe(logger),
    );
    expect(miss).toBeNull();
    expect(JSON.stringify(logs)).toContain("cache.verify_failed");
    const hit = (await Effect.runPromise(lookupEntry(reader, KEY, fetchManifest, verification())))!;
    expect(hit.namespace).toBe(NS);
    const tampered = await Effect.runPromise(restoreObjects(hit, async () => new TextEncoder().encode("2"), sha256Hex));
    expect(tampered).toBeNull();
    const restored = await Effect.runPromise(
      restoreObjects(hit, async (p) => new Uint8Array(await (await bucket.get(p))!.arrayBuffer()), sha256Hex),
    );
    expect(restored?.size).toBe(1);
  });

  it("[FD-CACHE-024] a pull-request reader restores its own namespace before a protected tier", async () => {
    await ok(commit(world([lease({ namespaces: { read: [], write: protectedCloud(REPO) } })]), { epoch: 2, manifest: { key: KEY, namespace: protectedCloud(REPO), objects: await upload(protectedCloud(REPO), 2, { a: "base" }) } }));
    expect((await Effect.runPromise(lookupEntry(reader, KEY, fetchManifest, verification())))?.namespace).toBe(protectedCloud(REPO));
    await ok(commit(world(), { epoch: 2, manifest: { key: KEY, namespace: NS, objects: await upload(NS, 2, { a: "pr" }) } }));
    expect((await Effect.runPromise(lookupEntry(reader, KEY, fetchManifest, verification())))?.namespace).toBe(NS);
  });

  it("[FD-CACHE-027] a required execution on a cloud executor skips an entry a device wrote", async () => {
    const device = await signingKeys();
    const spki = Buffer.from(await crypto.subtle.exportKey("spki", device.pair.publicKey)).toString("base64");
    const body = {
      key: KEY,
      namespace: NS,
      tier: "pull-request" as const,
      writer: { executor_id: "dev-1", executor_kind: "device" as const, execution_id: EXEC, epoch: 1 },
      objects: [],
      created_at: 0,
    };
    const deviceWritten: Manifest = {
      ...body,
      signature: { alg: "ES256", key_id: "dev-1", value: await es256Sign(device.pair.privateKey, signedBody(body)) },
    };
    const keysWithDevice = { controlPlane: keys.publicJwk, device: (id: string) => (id === "dev-1" ? spki : null) };
    const look = (cls: string) =>
      Effect.runPromise(lookupEntry({ ...reader, class: cls }, KEY, async () => deviceWritten, keysWithDevice));
    // The manifest verifies, so only the reader's class separates the hit from the skip.
    expect((await look("interactive"))?.manifest.writer.executor_id).toBe("dev-1");
    expect(await look("required")).toBeNull();
  });

  it("[FD-CACHE-028] a release or cloud-only reader restores nothing, and [FD-CACHE-011] a failing read is a miss", async () => {
    let reads = 0;
    const fetch = async () => {
      reads++;
      throw new Error("R2 down");
    };
    expect(await Effect.runPromise(lookupEntry({ ...reader, class: "release" }, KEY, fetch, verification()))).toBeNull();
    expect(await Effect.runPromise(lookupEntry({ ...reader, constraints: ["cloud-only"] }, KEY, fetch, verification()))).toBeNull();
    expect(reads).toBe(0);
    expect(await Effect.runPromise(lookupEntry(reader, KEY, fetch, verification()))).toBeNull();
    expect(reads).toBe(2);
  });

  it("[FD-CACHE-046] save skips the upload when a committed manifest exists, and [FD-CACHE-012] a failed write is logged, not raised", async () => {
    let uploads = 0;
    const upload = Effect.sync(() => void uploads++);
    expect(await Effect.runPromise(saveEntry({ key: KEY, committed: Effect.succeed(true), upload, commit: Effect.succeed("accepted") }))).toBe("skipped-existing");
    expect(uploads).toBe(0);
    expect(await Effect.runPromise(saveEntry({ key: KEY, committed: Effect.succeed(false), upload, commit: Effect.succeed("accepted") }))).toBe("saved");
    const logs: { message: unknown; key: unknown }[] = [];
    const capture = Effect.provide(
      Layer.succeed(
        Logger.CurrentLoggers,
        new Set([
          Logger.make((o) =>
            void logs.push({ message: o.message, key: o.fiber.getRef(References.CurrentLogAnnotations).key }),
          ),
        ]),
      ),
    );
    const saved = (committed: Effect.Effect<boolean>, up: Effect.Effect<void, string>) =>
      Effect.runPromise(saveEntry({ key: KEY, committed, upload: up, commit: Effect.succeed("accepted") }).pipe(capture));
    for (const [committed, up] of [
      [Effect.succeed(false), Effect.fail("507")],
      [Effect.die("boom"), upload],
    ] as const) {
      logs.length = 0;
      expect(await saved(committed, up)).toBe("failed");
      const failures = logs.filter((l) => JSON.stringify(l.message).includes("cache.save_failed"));
      expect(failures).toHaveLength(1);
      expect(failures[0]?.key).toBe(KEY);
    }
  });

  it("[FD-CACHE-061] a restore of an entry last read over TTL/2 ago refreshes last_read_at", async () => {
    const w = world();
    await ok(commit(w, { epoch: 2, manifest: { key: KEY, namespace: NS, objects: await upload(NS, 2, { a: "1" }) } }));
    const read = (await Effect.runPromise(readManifest(bucket, NS, KEY)))!;
    const day = 24 * 3600 * 1000;
    expect(await Effect.runPromise(refreshLastRead(bucket, read, w.now + 6 * day))).toBe(false);
    expect(await Effect.runPromise(refreshLastRead(bucket, read, w.now + 8 * day))).toBe(true);
    expect((await Effect.runPromise(readManifest(bucket, NS, KEY)))?.lastReadAt).toBe(w.now + 8 * day);
    // The signed body is unchanged, so the refreshed entry still verifies.
    expect(await Effect.runPromise(lookupEntry(reader, KEY, fetchManifest, verification()))).not.toBeNull();
  });
});
