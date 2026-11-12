// The private transparency log on the composed control plane: the control plane Worker under workerd through
// Miniflare, with its `TransparencyLog` Durable Object, its `CACHE` bucket and a log key. A verifier that reads only
// R2 recomputes the RFC 9162 root from the published leaves and tiles and proves each leaf against the signed
// checkpoint.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHECKPOINT_BOUND_MS,
  CHECKPOINT_PATH,
  emptyTreeHash,
  HASH_SIZE,
  inclusionProof,
  leafHash,
  leafPath,
  nodeHash,
  parseCheckpoint,
  parseProvenanceKey,
  PRIVATE_LOG_PREFIX,
  privateLogOf,
  storedHashesForAppend,
  verifyCheckpoint,
  verifyInclusion,
  type AppendOutcome,
  type Bucket,
  type ReadStoredHash,
} from "@fractalboxdev/flare-dispatch-cache";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PLANE = "plane-conformance";

interface LogStub {
  append(entry: Uint8Array): Promise<AppendOutcome>;
  checkpointDueAt(): Promise<number | null>;
}

let plane: Miniflare;
let logPublic: JsonWebKey & { readonly kid: string };

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  logPublic = {
    ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey),
    kid: "log-1",
  };
  const logKey = parseProvenanceKey(JSON.stringify({ ...priv, kid: "log-1" }));
  const bundle = await build({
    entryPoints: [join(import.meta.dirname, "../../../apps/control-plane/src/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    external: ["cloudflare:*"],
  });
  plane = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.js", contents: bundle.outputFiles[0]!.text }],
    compatibilityDate: "2026-05-01",
    d1Databases: { DB: "control-plane" },
    durableObjects: { TRANSPARENCY_LOG: { className: "TransparencyLog", useSQLite: true } },
    r2Buckets: ["CACHE"],
    bindings: { DEPLOYMENT: "development", PLANE_ID: PLANE, LOG_KEY: JSON.stringify(logKey) },
  });
  await plane.ready;
}, 120_000);

afterAll(async () => {
  await plane?.dispose();
});

/** The committed control plane configuration, comments and trailing commas stripped. */
const wranglerConfig = () =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../apps/control-plane/wrangler.jsonc"), "utf8")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,(\s*[}\]])/g, "$1"),
  ) as {
    durable_objects: { bindings: Array<{ name: string; class_name: string }> };
    migrations: Array<{ tag: string; new_sqlite_classes?: string[] }>;
  };

/** RFC 9162's MTH over leaf hashes, from its recursive definition. */
const mth = async (leaves: readonly Uint8Array[]): Promise<Uint8Array> => {
  if (leaves.length === 0) return emptyTreeHash();
  if (leaves.length === 1) return leaves[0]!;
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return nodeHash(await mth(leaves.slice(0, k)), await mth(leaves.slice(k)));
};

const hexOf = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

describe("the private transparency log on the control plane", () => {
  it("[FD-PROV-074] the control plane binds one TransparencyLog class on SQLite storage and exports it from its Worker", async () => {
    const config = wranglerConfig();
    expect(config.durable_objects.bindings).toContainEqual({
      name: "TRANSPARENCY_LOG",
      class_name: "TransparencyLog",
    });
    expect(
      config.durable_objects.bindings.filter((b) => b.class_name === "TransparencyLog"),
    ).toHaveLength(1);
    expect(config.migrations.flatMap((m) => m.new_sqlite_classes ?? [])).toContain(
      "TransparencyLog",
    );
    // Miniflare binds `TRANSPARENCY_LOG` to the bundled Worker's `TransparencyLog` export.
    expect(await plane.getDurableObjectNamespace("TRANSPARENCY_LOG")).toBeDefined();
  });

  it("[FD-PROV-074] [FD-PROV-037] the one log object assigns consecutive indexes, writes leaves and tiles to R2, and its alarm signs a checkpoint within 60 s that an R2 reader proves every leaf against", async () => {
    const ns = (await plane.getDurableObjectNamespace(
      "TRANSPARENCY_LOG",
    )) as unknown as DurableObjectNamespace;
    const log = privateLogOf(ns as never) as unknown as LogStub;
    const entries = Array.from({ length: 6 }, (_, i) =>
      new TextEncoder().encode(
        JSON.stringify({ payloadType: "application/vnd.in-toto+json", n: i }),
      ),
    );
    let firstAppend: number | undefined;
    for (const [index, entry] of entries.entries()) {
      const outcome = await log.append(entry);
      expect(outcome).toMatchObject({ _tag: "Appended", index, duplicate: false });
      if (firstAppend === undefined) {
        firstAppend = (outcome as { integratedAt: number }).integratedAt;
        // The first unsigned append binds FD-PROV-037's bound: each later one is no earlier than it.
        const due = await log.checkpointDueAt();
        expect(due).not.toBeNull();
        expect(due!).toBeLessThanOrEqual(firstAppend + CHECKPOINT_BOUND_MS);
      }
    }

    // The alarm may first sign a prefix of the entries; the poll waits for the checkpoint over all of them.
    const bucket = (await plane.getR2Bucket("CACHE")) as unknown as Bucket;
    let polled: ReturnType<typeof parseCheckpoint>;
    for (let waited = 0; polled?.size !== entries.length && waited < 30_000; waited += 250) {
      const got = await bucket.get(`${PRIVATE_LOG_PREFIX}${CHECKPOINT_PATH}`);
      polled = got === null ? undefined : parseCheckpoint(await got.text());
      if (polled?.size !== entries.length) await new Promise((r) => setTimeout(r, 250));
    }
    expect(polled).toBeDefined();
    const checkpoint = polled!;
    expect(checkpoint).toMatchObject({ origin: `${PLANE}/private-log`, size: entries.length });
    expect(await verifyCheckpoint(checkpoint, logPublic)).toBe(true);

    // The leaves and the level-0 tile, as any reader of the bucket sees them.
    const leaves: Uint8Array[] = [];
    for (const [index, entry] of entries.entries()) {
      const object = await bucket.get(`${PRIVATE_LOG_PREFIX}${leafPath(index)}`);
      const stored = new Uint8Array(await object!.arrayBuffer());
      expect(stored).toEqual(entry);
      leaves.push(await leafHash(stored));
    }
    const tileObject = await bucket.get(`${PRIVATE_LOG_PREFIX}tile/0/000.p/${entries.length}`);
    const tile = new Uint8Array(await tileObject!.arrayBuffer());
    expect(tile.byteLength).toBe(entries.length * HASH_SIZE);
    leaves.forEach((leaf, i) =>
      expect(hexOf(tile.slice(i * HASH_SIZE, (i + 1) * HASH_SIZE))).toBe(hexOf(leaf)),
    );
    expect(hexOf(checkpoint.root)).toBe(hexOf(await mth(leaves)));

    const stored = new Map<string, Uint8Array>();
    const read: ReadStoredHash = (level, index) => stored.get(`${level}/${index}`)!;
    for (const [index, leaf] of leaves.entries())
      for (const h of await storedHashesForAppend(index, leaf, read))
        stored.set(`${h.level}/${h.index}`, h.hash);
    for (const [index, leaf] of leaves.entries()) {
      const proof = await inclusionProof(index, leaves.length, read);
      expect(await verifyInclusion(index, leaves.length, leaf, proof, checkpoint.root)).toBe(true);
    }
  }, 60_000);
});
