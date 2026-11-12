// The private transparency log: RFC 9162 hashing, tree heads and inclusion proofs over the stored hashes, the signed
// checkpoint, and the `TransparencyLog` Durable Object under Miniflare, which assigns leaf indexes in its SQLite
// storage, writes leaves and tiles create-only, signs each checkpoint from its alarm and refuses any write that would
// change the log.
import type { Alarm } from "@fractalboxdev/mameko-ports";
import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hex, utf8 } from "../crypto.ts";
import type { Bucket } from "../manifest.ts";
import { startMiniflare } from "../support.test-support.ts";
import { parseProvenanceKey, type ProvenanceKey } from "./dsse.ts";
import {
  CHECKPOINT_BOUND_MS,
  CHECKPOINT_DELAY_MS,
  PRIVATE_LOG_REFUSED_ALARM,
  type AppendOutcome,
  type CheckpointOutcome,
  type PrivateLogInclusionProof,
} from "./log.ts";
import {
  CHECKPOINT_PATH,
  checkpointBody,
  emptyTreeHash,
  encodeTileIndex,
  HASH_SIZE,
  inclusionProof,
  leafHash,
  leafPath,
  newTiles,
  nodeHash,
  parseCheckpoint,
  signCheckpoint,
  storedHashesForAppend,
  tilePath,
  treeHead,
  verifyCheckpoint,
  verifyInclusion,
  type ReadStoredHash,
} from "./merkle.ts";
import type { PolicyWitness } from "./policy.ts";
import { WITNESS_RETRY_MIN_MS } from "./witness.ts";
import { witnessOf } from "./witness.test-support.ts";

const bytes = (...values: number[]) => Uint8Array.from(values);

/** RFC 9162 § 2.1.1's MTH, written straight from its recursive definition over the entries. */
const referenceRoot = async (entries: readonly Uint8Array[]): Promise<Uint8Array> => {
  if (entries.length === 0) return emptyTreeHash();
  if (entries.length === 1) return leafHash(entries[0]!);
  let k = 1;
  while (k * 2 < entries.length) k *= 2;
  return nodeHash(await referenceRoot(entries.slice(0, k)), await referenceRoot(entries.slice(k)));
};

/** A tree built leaf by leaf through the stored hashes, as the `TransparencyLog` object builds it. */
const storedTree = async (entries: readonly Uint8Array[]) => {
  const stored = new Map<string, Uint8Array>();
  const read: ReadStoredHash = (level, index) => {
    const hash = stored.get(`${level}/${index}`);
    if (hash === undefined) throw new Error(`no stored hash ${level}/${index}`);
    return hash;
  };
  for (const [index, entry] of entries.entries())
    for (const h of await storedHashesForAppend(index, await leafHash(entry), read))
      stored.set(`${h.level}/${h.index}`, h.hash);
  return read;
};

// The Certificate Transparency reference inputs and the tree heads of their first n leaves (RFC 6962's test data,
// whose leaf and node hashing RFC 9162 keeps).
const CT_LEAVES = [
  bytes(),
  bytes(0x00),
  bytes(0x10),
  bytes(0x20, 0x21),
  bytes(0x30, 0x31),
  bytes(0x40, 0x41, 0x42, 0x43),
  bytes(0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57),
  bytes(...Array.from({ length: 16 }, (_, i) => 0x60 + i)),
];
const CT_ROOTS = [
  "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
  "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
  "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
  "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
  "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
  "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
  "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
  "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328",
];

const keyPair = async (kid: string) => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    private: parseProvenanceKey(JSON.stringify({ ...priv, kid })) as ProvenanceKey,
    public: { ...pub, kid },
  };
};

describe("the private log's Merkle tree", () => {
  it("[FD-PROV-037] hashes leaves as SHA-256(0x00 ‖ entry) and nodes as SHA-256(0x01 ‖ left ‖ right), matching the RFC 9162 tree heads of the reference inputs", async () => {
    const empty = await crypto.subtle.digest("SHA-256", bytes(0x00));
    expect(hex(await leafHash(bytes()))).toBe(hex(empty));
    const read = await storedTree(CT_LEAVES);
    for (let size = 1; size <= CT_LEAVES.length; size++)
      expect(hex(await treeHead(size, read))).toBe(CT_ROOTS[size - 1]);
    expect(hex(await treeHead(0, read))).toBe(hex(await crypto.subtle.digest("SHA-256", bytes())));
  });

  it("[FD-PROV-037] the tree head over the stored hashes equals RFC 9162's MTH at every size, across a tile boundary", async () => {
    const entries = Array.from({ length: 300 }, (_, i) => utf8(`entry-${i}`));
    const read = await storedTree(entries);
    for (const size of [1, 2, 3, 7, 8, 9, 100, 255, 256, 257, 300])
      expect(hex(await treeHead(size, read))).toBe(
        hex(await referenceRoot(entries.slice(0, size))),
      );
  });

  it("[FD-PROV-037] an RFC 9162 inclusion proof verifies for every leaf of every tree size, and fails for a changed leaf or proof", async () => {
    const entries = Array.from({ length: 20 }, (_, i) => utf8(`leaf-${i}`));
    const read = await storedTree(entries);
    for (let size = 1; size <= entries.length; size++) {
      const root = await treeHead(size, read);
      for (let index = 0; index < size; index++) {
        const proof = await inclusionProof(index, size, read);
        const leaf = await leafHash(entries[index]!);
        expect(await verifyInclusion(index, size, leaf, proof, root)).toBe(true);
        expect(await verifyInclusion(index, size, await leafHash(utf8("other")), proof, root)).toBe(
          false,
        );
        if (proof.length > 0) {
          const bent = proof.map((p, i) => (i === 0 ? Uint8Array.from(p, (b) => b ^ 1) : p));
          expect(await verifyInclusion(index, size, leaf, bent, root)).toBe(false);
        }
      }
    }
  });

  it("[FD-PROV-037] a checkpoint carries the origin, size and root, verifies under the log key, and fails under another key or with a changed size", async () => {
    const log = await keyPair("log-1");
    const other = await keyPair("log-1");
    const root = await treeHead(3, await storedTree(CT_LEAVES));
    const text = await signCheckpoint(
      { origin: "ci.example.com/private-log", size: 3, root },
      log.private,
    );
    const parsed = parseCheckpoint(text)!;
    expect(parsed).toMatchObject({ origin: "ci.example.com/private-log", size: 3 });
    expect(hex(parsed.root)).toBe(CT_ROOTS[2]);
    expect(parsed.body).toBe(
      checkpointBody({ origin: "ci.example.com/private-log", size: 3, root }),
    );
    expect(await verifyCheckpoint(parsed, log.public)).toBe(true);
    expect(await verifyCheckpoint(parsed, other.public)).toBe(false);
    const grown = parseCheckpoint(text.replace("\n3\n", "\n4\n"))!;
    expect(await verifyCheckpoint(grown, log.public)).toBe(false);
  });

  it("[FD-PROV-074] tiles follow C2SP tlog-tiles paths, and growth adds a new partial tile at each width rather than rewriting one", () => {
    expect(encodeTileIndex(0)).toBe("000");
    expect(encodeTileIndex(1234067)).toBe("x001/x234/067");
    expect(tilePath({ level: 0, index: 1, width: 256 })).toBe("tile/0/001");
    expect(tilePath({ level: 1, index: 0, width: 3 })).toBe("tile/1/000.p/3");
    expect(leafPath(1000)).toBe("leaf/x001/000");
    expect(newTiles(0, 3)).toEqual([{ level: 0, index: 0, width: 3 }]);
    expect(newTiles(3, 5)).toEqual([{ level: 0, index: 0, width: 5 }]);
    expect(newTiles(250, 257)).toEqual([
      { level: 0, index: 0, width: 256 },
      { level: 0, index: 1, width: 1 },
      { level: 1, index: 0, width: 1 },
    ]);
    expect(newTiles(257, 257)).toEqual([]);
  });
});

interface LogStub {
  append(entry: Uint8Array): Promise<AppendOutcome>;
  checkpoint(): Promise<CheckpointOutcome>;
  checkpointDueAt(): Promise<number | null>;
  inclusionProof(index: number): Promise<PrivateLogInclusionProof | null>;
  size(): Promise<number>;
  usePrefix(prefix: string): Promise<void>;
  failLeafWrites(n: number): Promise<void>;
  useWitness(witness: PolicyWitness, answer: string | null): Promise<void>;
  delivered(): Promise<readonly Alarm[]>;
}

describe("the TransparencyLog Durable Object", () => {
  let mf: Miniflare;
  let bucket: Bucket;
  let logKey: Awaited<ReturnType<typeof keyPair>>;
  let objects = 0;

  beforeAll(async () => {
    logKey = await keyPair("log-key-1");
    ({ mf, bucket } = await startMiniflare({ LOG_KEY: JSON.stringify(logKey.private) }));
  });
  afterAll(async () => {
    await mf?.dispose();
  });

  /** A fresh object writing under a prefix of its own. */
  const freshLog = async () => {
    const n = ++objects;
    const ns = (await mf.getDurableObjectNamespace(
      "TRANSPARENCY_LOG",
    )) as unknown as DurableObjectNamespace;
    const log = ns.get(ns.idFromName(`log-${n}`)) as unknown as LogStub;
    const prefix = `t${n}/`;
    await log.usePrefix(prefix);
    return { log, prefix };
  };

  const object = async (key: string) => {
    const got = await bucket.get(key);
    return got === null ? null : new Uint8Array(await got.arrayBuffer());
  };

  const refusals = async (log: LogStub) =>
    (await log.delivered()).filter((a) => a.name === PRIVATE_LOG_REFUSED_ALARM);

  /** The published checkpoint once it covers `size` leaves: the alarm may first sign a prefix of them. */
  const checkpointOf = async (prefix: string, size: number) => {
    for (let waited = 0; waited < 20_000; waited += 200) {
      const got = await bucket.get(`${prefix}${CHECKPOINT_PATH}`);
      const checkpoint = got === null ? undefined : parseCheckpoint(await got.text());
      if (checkpoint?.size === size) return checkpoint;
      await new Promise((r) => setTimeout(r, 200));
    }
    return undefined;
  };

  /** The alarm once a run re-arms it later than `after`, and when the suite saw it. */
  const armedAfter = async (log: LogStub, after: number) => {
    for (let waited = 0; waited < 20_000; waited += 200) {
      const due = await log.checkpointDueAt();
      if (due !== null && due > after) return { due, seenAt: Date.now() };
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`no alarm armed after ${after}`);
  };

  /** A checkpoint run's outcome once the tree is signed at `size`, by this run or by the alarm before it. */
  const expectSignedAt = (outcome: CheckpointOutcome, size: number) => {
    expect(["Published", "Unchanged"]).toContain(outcome._tag);
    expect(outcome).toMatchObject({ size });
  };

  it("[FD-PROV-074] assigns each leaf the next index in its SQLite storage, answers a repeated entry with its first index, and writes each leaf to R2", async () => {
    const { log, prefix } = await freshLog();
    const entries = ["a", "b", "c"].map((e) => utf8(`envelope-${e}`));
    const outcomes: AppendOutcome[] = [];
    for (const entry of entries) outcomes.push(await log.append(entry));
    expect(outcomes).toMatchObject([
      { _tag: "Appended", index: 0, duplicate: false },
      { _tag: "Appended", index: 1, duplicate: false },
      { _tag: "Appended", index: 2, duplicate: false },
    ]);
    expect(await log.append(entries[1]!)).toMatchObject({
      _tag: "Appended",
      index: 1,
      duplicate: true,
    });
    expect(await log.size()).toBe(3);
    for (const [index, entry] of entries.entries())
      expect(await object(`${prefix}${leafPath(index)}`)).toEqual(entry);
    expect(outcomes[0]).toMatchObject({ leafHash: hex(await leafHash(entries[0]!)) });
  });

  it("[FD-PROV-074] [FD-PROV-037] an append arms the alarm within 60 s, and the alarm signs a checkpoint over the RFC 9162 root with the log key", async () => {
    const { log, prefix } = await freshLog();
    const entries = ["x", "y", "z", "w", "v"].map((e) => utf8(`statement-${e}`));
    const firstAppend = ((await log.append(entries[0]!)) as { integratedAt: number }).integratedAt;
    // The first unsigned append binds FD-PROV-037's bound: each later one is no earlier than it.
    const due = await log.checkpointDueAt();
    expect(due).not.toBeNull();
    expect(due!).toBeLessThanOrEqual(firstAppend + CHECKPOINT_BOUND_MS);
    for (const entry of entries.slice(1)) await log.append(entry);

    const checkpoint = (await checkpointOf(prefix, entries.length))!;
    expect(checkpoint).toBeDefined();
    expect(checkpoint).toMatchObject({ origin: "ci.example.com/private-log", size: 5 });
    expect(hex(checkpoint.root)).toBe(hex(await referenceRoot(entries)));
    expect(await verifyCheckpoint(checkpoint, logKey.public)).toBe(true);
    // The tile holds every leaf hash, so a reader of R2 alone recomputes the root and proves each leaf.
    const tile = (await object(`${prefix}tile/0/000.p/5`))!;
    expect(tile.byteLength).toBe(5 * HASH_SIZE);
    for (const [index, entry] of entries.entries())
      expect(hex(tile.slice(index * HASH_SIZE, (index + 1) * HASH_SIZE))).toBe(
        hex(await leafHash(entry)),
      );
    expect(await log.checkpoint()).toMatchObject({ _tag: "Unchanged", size: 5 });
  });

  it("[FD-PROV-037] [FD-PROV-039] a round that leaves a cosignature missing re-arms with back-off, and an append pulls that retry back within the checkpoint delay", async () => {
    const { log, prefix } = await freshLog();
    const down = await witnessOf("witness-down.example");
    await log.useWitness({ name: down.name, key: down.vkey, url: "https://down.example/" }, null);

    const first = (await log.append(utf8("unwitnessed-0"))) as { integratedAt: number };
    const retry = await armedAfter(log, first.integratedAt + CHECKPOINT_DELAY_MS);
    expect(await checkpointOf(prefix, 1)).toBeDefined();
    expect(retry.due).toBeGreaterThanOrEqual(first.integratedAt + WITNESS_RETRY_MIN_MS);
    expect(retry.due).toBeLessThanOrEqual(retry.seenAt + WITNESS_RETRY_MIN_MS);

    // The retry is armed further out than the checkpoint delay; an append arms the alarm within it.
    const second = (await log.append(utf8("unwitnessed-1"))) as { integratedAt: number };
    const due = (await log.checkpointDueAt())!;
    expect(due).toBeLessThanOrEqual(second.integratedAt + CHECKPOINT_DELAY_MS);

    // That checkpoint run's witness round leaves the cosignature missing again, and the delay doubles.
    const doubled = await armedAfter(log, due);
    expect(await checkpointOf(prefix, 2)).toBeDefined();
    expect(doubled.due).toBeGreaterThanOrEqual(second.integratedAt + 2 * WITNESS_RETRY_MIN_MS);
    expect(doubled.due).toBeLessThanOrEqual(doubled.seenAt + 2 * WITNESS_RETRY_MIN_MS);
  });

  it("[FD-PROV-039] a round that leaves no cosignature missing arms no witness retry", async () => {
    const { log, prefix } = await freshLog();
    const up = await witnessOf("witness-up.example");
    const entry = utf8("witnessed-0");
    const line = await up.cosign(
      checkpointBody({
        origin: "ci.example.com/private-log",
        size: 1,
        root: await leafHash(entry),
      }),
      1_780_000_000,
    );
    await log.useWitness({ name: up.name, key: up.vkey, url: "https://up.example/" }, `${line}\n`);
    await log.append(entry);

    let cosigned = false;
    for (let waited = 0; waited < 20_000 && !cosigned; waited += 200) {
      const got = await bucket.get(`${prefix}${CHECKPOINT_PATH}`);
      cosigned = got !== null && (await got.text()).endsWith(`${line}\n`);
      if (!cosigned) await new Promise((r) => setTimeout(r, 200));
    }
    expect(cosigned).toBe(true);
    let due = await log.checkpointDueAt();
    for (let waited = 0; waited < 5_000 && due !== null; waited += 200) {
      await new Promise((r) => setTimeout(r, 200));
      due = await log.checkpointDueAt();
    }
    expect(due).toBeNull();
  });

  it("answers each leaf's RFC 9162 inclusion proof against the published checkpoint, and none for a leaf it does not cover", async () => {
    const { log, prefix } = await freshLog();
    expect(await log.inclusionProof(0)).toBeNull();
    const entries = ["p", "q", "r"].map((e) => utf8(`proved-${e}`));
    for (const entry of entries) await log.append(entry);
    const checkpoint = (await checkpointOf(prefix, entries.length))!;
    const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    for (const [index, entry] of entries.entries()) {
      const proof = (await log.inclusionProof(index))!;
      expect(proof).toMatchObject({ leafIndex: index, treeSize: 3 });
      expect(parseCheckpoint(proof.checkpoint)).toEqual(checkpoint);
      const hashes = proof.hashes.map(fromBase64);
      expect(await verifyInclusion(index, 3, await leafHash(entry), hashes, checkpoint.root)).toBe(true);
    }
    expect(await log.inclusionProof(3)).toBeNull();
    expect(await log.inclusionProof(-1)).toBeNull();
  });

  it("[FD-PROV-074] writes full and partial tiles once each: growth adds new partial tiles beside the earlier ones and the checkpoint advances", async () => {
    const { log, prefix } = await freshLog();
    const entries = Array.from({ length: 260 }, (_, i) => utf8(`grow-${i}`));
    for (const entry of entries.slice(0, 257)) await log.append(entry);
    // The alarm may sign first; either way a checkpoint over 257 leaves is published.
    expectSignedAt(await log.checkpoint(), 257);
    const fullTile = await object(`${prefix}tile/0/000`);
    expect(fullTile?.byteLength).toBe(256 * HASH_SIZE);
    const levelOne = await object(`${prefix}tile/1/000.p/1`);
    // The level-1 tile holds the root of the first 256 leaves.
    expect(hex(levelOne!)).toBe(hex(await referenceRoot(entries.slice(0, 256))));
    const firstPartial = await object(`${prefix}tile/0/001.p/1`);
    for (const entry of entries.slice(257)) await log.append(entry);
    expectSignedAt(await log.checkpoint(), 260);
    expect(await object(`${prefix}tile/0/001.p/1`)).toEqual(firstPartial);
    expect((await object(`${prefix}tile/0/001.p/4`))?.byteLength).toBe(4 * HASH_SIZE);
    const checkpoint = parseCheckpoint(
      new TextDecoder().decode((await object(`${prefix}${CHECKPOINT_PATH}`))!),
    )!;
    expect(checkpoint.size).toBe(260);
    expect(hex(checkpoint.root)).toBe(hex(await referenceRoot(entries)));
  });

  it("[FD-PROV-074] a leaf put whose answer is lost keeps its index: the next append writes it again and takes the next index, with no page", async () => {
    const { log, prefix } = await freshLog();
    await log.append(utf8("before"));
    await log.failLeafWrites(1);
    await expect(log.append(utf8("lost"))).rejects.toThrow();
    expect(await object(`${prefix}${leafPath(1)}`)).toEqual(utf8("lost"));
    expect(await log.append(utf8("next"))).toMatchObject({
      _tag: "Appended",
      index: 2,
      duplicate: false,
    });
    expect(await log.append(utf8("lost"))).toMatchObject({
      _tag: "Appended",
      index: 1,
      duplicate: true,
    });
    expect(await object(`${prefix}${leafPath(2)}`)).toEqual(utf8("next"));
    expect(await log.size()).toBe(3);
    expect(await refusals(log)).toEqual([]);
    expect(await log.checkpointDueAt()).not.toBeNull();
  });

  it("[FD-PROV-038] refuses an append while a recorded leaf's object holds other bytes, and raises a page alarm", async () => {
    const { log, prefix } = await freshLog();
    await log.failLeafWrites(1);
    await expect(log.append(utf8("recorded"))).rejects.toThrow();
    await bucket.put(`${prefix}${leafPath(0)}`, utf8("overwritten"));
    expect(await log.append(utf8("after"))).toMatchObject({
      _tag: "Refused",
      reason: "leaf-changed",
      path: `${prefix}${leafPath(0)}`,
    });
    expect(await log.size()).toBe(1);
    expect((await refusals(log))[0]).toMatchObject({
      severity: "page",
      detail: { reason: "leaf-changed", detail: { index: 0, recorded: true } },
    });
  });

  it("[FD-PROV-038] refuses an append whose leaf would overwrite a foreign leaf object at an index no leaf held, records nothing and raises a page alarm", async () => {
    const { log, prefix } = await freshLog();
    await log.append(utf8("first"));
    await bucket.put(`${prefix}${leafPath(1)}`, utf8("planted"));
    expect(await log.append(utf8("second"))).toMatchObject({
      _tag: "Refused",
      reason: "leaf-changed",
      path: `${prefix}${leafPath(1)}`,
    });
    expect(await log.size()).toBe(1);
    expect(await object(`${prefix}${leafPath(1)}`)).toEqual(utf8("planted"));
    expect((await refusals(log))[0]).toMatchObject({
      name: PRIVATE_LOG_REFUSED_ALARM,
      severity: "page",
      state: "raised",
      detail: { reason: "leaf-changed" },
    });
  });

  it("[FD-PROV-038] accepts a retried leaf write whose existing object holds the same bytes", async () => {
    const { log, prefix } = await freshLog();
    await bucket.put(`${prefix}${leafPath(0)}`, utf8("retried"));
    expect(await log.append(utf8("retried"))).toMatchObject({ _tag: "Appended", index: 0 });
    expect(await refusals(log)).toEqual([]);
  });

  it("[FD-PROV-038] refuses a checkpoint that would reduce the published tree size, leaves the published checkpoint in place and raises a page alarm", async () => {
    const { log, prefix } = await freshLog();
    for (const e of ["p", "q"]) await log.append(utf8(e));
    const published = await signCheckpoint(
      { origin: "ci.example.com/private-log", size: 9, root: new Uint8Array(HASH_SIZE) },
      logKey.private,
    );
    await bucket.put(`${prefix}${CHECKPOINT_PATH}`, published);
    expect(await log.checkpoint()).toMatchObject({ _tag: "Refused", reason: "tree-size-reduced" });
    expect(new TextDecoder().decode((await object(`${prefix}${CHECKPOINT_PATH}`))!)).toBe(
      published,
    );
    expect((await refusals(log))[0]).toMatchObject({
      severity: "page",
      detail: { reason: "tree-size-reduced", detail: { published: 9, size: 2 } },
    });
  });

  it("[FD-PROV-038] refuses a checkpoint whose published root differs from its own at that size, since an existing leaf would change", async () => {
    const { log, prefix } = await freshLog();
    for (const e of ["r", "s", "t"]) await log.append(utf8(e));
    const forged = await referenceRoot([utf8("r"), utf8("not-s")]);
    await bucket.put(
      `${prefix}${CHECKPOINT_PATH}`,
      await signCheckpoint(
        { origin: "ci.example.com/private-log", size: 2, root: forged },
        logKey.private,
      ),
    );
    expect(await log.checkpoint()).toMatchObject({ _tag: "Refused", reason: "root-changed" });
    expect((await refusals(log))[0]).toMatchObject({
      severity: "page",
      detail: { reason: "root-changed" },
    });
  });

  it("[FD-PROV-038] refuses a checkpoint whose tile would overwrite an existing tile object with other bytes", async () => {
    const { log, prefix } = await freshLog();
    for (const e of ["u", "v"]) await log.append(utf8(e));
    await bucket.put(`${prefix}tile/0/000.p/2`, new Uint8Array(2 * HASH_SIZE));
    expect(await log.checkpoint()).toMatchObject({
      _tag: "Refused",
      reason: "tile-changed",
      path: `${prefix}tile/0/000.p/2`,
    });
    expect(await object(`${prefix}${CHECKPOINT_PATH}`)).toBeNull();
    expect((await refusals(log))[0]).toMatchObject({
      severity: "page",
      detail: { reason: "tile-changed" },
    });
  });
});
