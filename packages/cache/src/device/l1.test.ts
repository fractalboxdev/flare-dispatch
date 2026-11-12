// L1 against an in-memory disk and an in-memory L2, and on a real directory for the one-directory-per-namespace
// layout. The device executor that calls these operations over its socket is mameko's and is not run here.
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../crypto.ts";
import { es256Sign, signedBody, type Manifest } from "../manifest.ts";
import { protectedCloud, pullRequestNamespace } from "../namespaces.ts";
import { signingKeys } from "../support.test-support.ts";
import {
  answerCacheRequest,
  fetchFromPeers,
  memoryDisk,
  nodeDisk,
  openL1,
  restoreContent,
  type L2Client,
  type L2Entry,
} from "./l1.ts";

const NS = pullRequestNamespace("acme/widgets", 7);
const key = (n: number) => n.toString(16).padStart(64, "0");
const bytes = (text: string) => new TextEncoder().encode(text);
const run = <A>(e: Effect.Effect<A>) => Effect.runPromise(e);

const entryFor = async (privateKey: CryptoKey, namespace: string, k: string, body: Uint8Array): Promise<L2Entry> => {
  const path = `cache/${namespace}/${k}/e.1/blob`;
  const unsigned = {
    key: k,
    namespace,
    tier: "pull-request" as const,
    writer: { executor_id: "cf-1", executor_kind: "cloudflare", execution_id: "e", epoch: 1 },
    objects: [{ path, size: body.byteLength, sha256: await sha256Hex(body) }],
    created_at: 0,
  };
  const manifest: Manifest = { ...unsigned, signature: { alg: "ES256", key_id: "control-plane", value: await es256Sign(privateKey, signedBody(unsigned)) } };
  return { manifest, objects: new Map([[path, body]]) };
};

const memoryL2 = () => {
  const entries = new Map<string, L2Entry>();
  const uploads: string[] = [];
  const client: L2Client = {
    fetch: async (ns, k) => entries.get(`${ns}/${k}`) ?? null,
    upload: async (ns, k) => void uploads.push(`${ns}/${k}`),
  };
  return { entries, uploads, client };
};

describe("L1 on the device", async () => {
  const keys = await signingKeys();
  const verification = { controlPlane: keys.publicJwk, device: () => null };

  it("[FD-CACHE-004] keeps one directory per namespace on local disk and serves cache.get, cache.put and cache.evict", async () => {
    const root = mkdtempSync(join(tmpdir(), "fd-l1-"));
    const l1 = await openL1({ disk: nodeDisk(root), l2: memoryL2().client, keys: verification });
    const put = await run(answerCacheRequest(l1, { type: "cache.put", id: "1", namespace: NS, key: key(1), bytes: Buffer.from("abc").toString("base64") }));
    expect(put).toEqual({ type: "cache.put.ok", id: "1.ok", ref: "1", digest: `sha256:${await sha256Hex("abc")}` });
    await run(l1.put(protectedCloud("acme/widgets"), key(2), bytes("def")));
    expect(readdirSync(join(root, "pr/acme/widgets/7"))).toEqual([key(1)]);
    expect(readdirSync(join(root, "protected/acme/widgets/cloud"))).toEqual([key(2)]);
    const got = await run(answerCacheRequest(l1, { type: "cache.get", id: "2", namespace: NS, key: key(1) }));
    expect(got).toMatchObject({ type: "cache.get.ok", bytes: Buffer.from("abc").toString("base64") });
    expect(await run(answerCacheRequest(l1, { type: "cache.evict", id: "3", target_bytes: 1 }))).toMatchObject({ type: "cache.evict.ok", freed_bytes: 3 });
    // A namespace outside the grammar reaches no path.
    expect(await run(l1.get("../../etc", key(1)))).toBeNull();
  });

  it("[FD-CACHE-006] a miss reads through to L2 and places the entry only after every digest verifies", async () => {
    const l2 = memoryL2();
    l2.entries.set(`${NS}/${key(1)}`, await entryFor(keys.pair.privateKey, NS, key(1), bytes("good")));
    const tampered = await entryFor(keys.pair.privateKey, NS, key(2), bytes("good"));
    l2.entries.set(`${NS}/${key(2)}`, { ...tampered, objects: new Map([[tampered.manifest.objects[0]!.path, bytes("evil")]]) });
    const disk = memoryDisk(1_000_000);
    const l1 = await openL1({ disk, l2: l2.client, keys: verification });
    expect(new TextDecoder().decode((await run(l1.get(NS, key(1))))!)).toBe("good");
    expect(disk.files.has(`${NS}/${key(1)}`)).toBe(true);
    expect(await run(l1.get(NS, key(2)))).toBeNull();
    expect(disk.files.has(`${NS}/${key(2)}`)).toBe(false);
  });

  it("[FD-CACHE-007] a put writes L1 and then uploads to L2; a failed upload leaves the L1 entry", async () => {
    const l2 = memoryL2();
    const disk = memoryDisk(1_000_000);
    const l1 = await openL1({ disk, l2: l2.client, keys: verification });
    await run(l1.put(NS, key(1), bytes("x")));
    expect(disk.files.has(`${NS}/${key(1)}`)).toBe(true);
    expect(l2.uploads).toEqual([`${NS}/${key(1)}`]);
    const failing = await openL1({ disk, l2: { ...l2.client, upload: async () => { throw new Error("507"); } }, keys: verification });
    await run(failing.put(NS, key(2), bytes("y")));
    expect(disk.files.has(`${NS}/${key(2)}`)).toBe(true);
  });

  it("[FD-CACHE-008] [FD-CACHE-013] a confidential namespace or an offline lease never reads or writes L2", async () => {
    const l2 = memoryL2();
    l2.entries.set(`${NS}/${key(1)}`, await entryFor(keys.pair.privateKey, NS, key(1), bytes("good")));
    for (const opts of [{ offline: () => true }, { confidential: () => true }]) {
      const l1 = await openL1({ disk: memoryDisk(1_000_000), l2: l2.client, keys: verification, ...opts });
      expect(await run(l1.get(NS, key(1)))).toBeNull();
      await run(l1.put(NS, key(3), bytes("z")));
    }
    expect(l2.uploads).toEqual([]);
  });

  it("[FD-CACHE-009] L1 caps at 20% of the free disk at start and evicts the least recently read entry first", async () => {
    let t = 0;
    const disk = memoryDisk(100);
    const l1 = await openL1({ disk, l2: memoryL2().client, keys: verification, now: () => ++t });
    expect(l1.usage().cap).toBe(20);
    await run(l1.put(NS, key(1), new Uint8Array(8)));
    await run(l1.put(NS, key(2), new Uint8Array(8)));
    await run(l1.get(NS, key(1)));
    await run(l1.put(NS, key(3), new Uint8Array(8)));
    expect([...disk.files.keys()].sort()).toEqual([`${NS}/${key(1)}`, `${NS}/${key(3)}`]);
    expect(l1.usage().bytes).toBeLessThanOrEqual(20);
    const half = await openL1({ disk: memoryDisk(100), l2: memoryL2().client, keys: verification, share: 0.5 });
    expect(half.usage().cap).toBe(50);
  });

  it("[FD-CACHE-009] re-putting a resident key within the cap keeps every other entry, and an over-cap put drops the stale one", async () => {
    const disk = memoryDisk(150);
    const l1 = await openL1({ disk, l2: memoryL2().client, keys: verification });
    expect(l1.usage().cap).toBe(30);
    await run(l1.put(NS, key(1), new Uint8Array(10)));
    await run(l1.put(NS, key(2), new Uint8Array(15)));
    await run(l1.put(NS, key(2), new Uint8Array(15)));
    expect(l1.usage()).toMatchObject({ bytes: 25, entries: 2 });
    expect([...disk.files.keys()].sort()).toEqual([`${NS}/${key(1)}`, `${NS}/${key(2)}`]);
    // Bytes larger than the cap are not stored, and the entry they replace no longer answers for the key.
    await run(l1.put(NS, key(2), new Uint8Array(31)));
    expect(await run(l1.peek(NS, key(2)))).toBeNull();
    expect(l1.usage()).toMatchObject({ bytes: 10, entries: 1 });
  });

  it("[FD-CACHE-010] cache.evict frees least recently read entries until the target or empty and returns the bytes freed", async () => {
    let t = 0;
    const disk = memoryDisk(1000);
    const l1 = await openL1({ disk, l2: memoryL2().client, keys: verification, now: () => ++t });
    for (let i = 1; i <= 4; i++) await run(l1.put(NS, key(i), new Uint8Array(10)));
    await run(l1.get(NS, key(1)));
    expect(await run(l1.evict(15))).toBe(20);
    expect([...disk.files.keys()].sort()).toEqual([`${NS}/${key(1)}`, `${NS}/${key(4)}`]);
    expect(await run(l1.evict(1000))).toBe(20);
    expect(disk.files.size).toBe(0);
  });

  it("[FD-CACHE-030] a content-tier restore requests only a trusted digest and hashes the bytes to it", async () => {
    const good = bytes("tarball");
    const digest = await sha256Hex(good);
    let fetched = 0;
    const fetch = async () => (fetched++, good);
    expect(await run(restoreContent(digest, new Set(), fetch))).toBeNull();
    expect(fetched).toBe(0);
    expect(await run(restoreContent(digest, new Set([digest]), fetch))).toEqual(good);
    expect(await run(restoreContent(digest, new Set([digest]), async () => bytes("other")))).toBeNull();
  });

  it("[FD-CACHE-014] a peer's entry from the same member is placed only after its signature and digests verify", async () => {
    const disk = memoryDisk(1_000_000);
    const l1 = await openL1({ disk, l2: memoryL2().client, keys: verification });
    const good = await entryFor(keys.pair.privateKey, NS, key(1), bytes("peer"));
    const other = await signingKeys();
    const forged = await entryFor(other.pair.privateKey, NS, key(1), bytes("evil"));
    const peer = (member: string, entry: L2Entry) => ({ member, fetch: async () => entry });
    expect(await run(fetchFromPeers(l1, "m1", [peer("m1", good)], NS, key(1), false))).toBe(false);
    expect(await run(fetchFromPeers(l1, "m1", [peer("m2", good)], NS, key(1), true))).toBe(false);
    expect(await run(fetchFromPeers(l1, "m1", [peer("m1", forged)], NS, key(1), true))).toBe(false);
    expect(disk.files.size).toBe(0);
    expect(await run(fetchFromPeers(l1, "m1", [peer("m1", forged), peer("m1", good)], NS, key(1), true))).toBe(true);
    expect(new TextDecoder().decode(disk.files.get(`${NS}/${key(1)}`)!)).toBe("peer");
  });
});
