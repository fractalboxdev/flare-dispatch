// L1: FlareDispatch's device extension's cache on the device's local disk (specs/cache-artifacts.md § Two-level
// cache). One directory per cache namespace; entries are evicted least recently read first. It answers mameko's
// device extension operations `cache.get`, `cache.put` and `cache.evict` (packages/protocol extension.ts), reads
// through to L2 on a miss and uploads to L2 after a put. This entry point uses Node's filesystem and is not part of
// the Worker bundle.
import { mkdir, readdir, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { sha256Hex } from "../crypto.ts";
import { verifyManifest, type Manifest, type VerificationKeys } from "../manifest.ts";

/** The disk L1 lives on: byte files under a root, and the free bytes measured at start. */
export interface L1Disk {
  readonly read: (path: string) => Promise<Uint8Array | null>;
  readonly write: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
  /** Every stored file with its size, relative to the root. */
  readonly list: () => Promise<readonly { readonly path: string; readonly size: number }[]>;
  readonly freeBytes: () => Promise<number>;
}

/** An L2 entry as L1 reads and writes it: one object holding the entry's bytes, plus its manifest. */
export interface L2Entry {
  readonly manifest: Manifest;
  readonly objects: ReadonlyMap<string, Uint8Array>;
}

/** L2 as the device extension reaches it: through the control plane's presigned URLs under the device's lease. */
export interface L2Client {
  readonly fetch: (namespace: string, key: string) => Promise<L2Entry | null>;
  readonly upload: (namespace: string, key: string, bytes: Uint8Array) => Promise<void>;
}

export interface L1Options {
  readonly disk: L1Disk;
  readonly l2: L2Client;
  readonly keys: VerificationKeys;
  /** Share of the free disk measured at start that L1 may use, default 20% (FD-CACHE-009). */
  readonly share?: number;
  readonly now?: () => number;
  /** True while the capacity lease is in offline mode: every L2 read is a miss (FD-CACHE-013). */
  readonly offline?: () => boolean;
  /** True for a `confidential-compute` repository's namespace: no L2 read or write (FD-CACHE-008). */
  readonly confidential?: (namespace: string) => boolean;
}

interface Entry {
  readonly namespace: string;
  readonly key: string;
  readonly size: number;
  lastReadAt: number;
}

const NAMESPACE = /^[a-z0-9._/-]{1,300}$/;
const KEY = /^[0-9a-f]{64}$/;
const safe = (namespace: string, key: string) =>
  NAMESPACE.test(namespace) && !namespace.split("/").some((s) => s === "" || s === "." || s === "..") && KEY.test(key);
/** One directory per namespace (FD-CACHE-004). */
const pathOf = (namespace: string, key: string) => `${namespace}/${key}`;

export interface L1Cache {
  readonly get: (namespace: string, key: string) => Effect.Effect<Uint8Array | null>;
  readonly put: (namespace: string, key: string, bytes: Uint8Array) => Effect.Effect<string>;
  readonly evict: (targetBytes: number) => Effect.Effect<number>;
  /** Places an entry fetched from somewhere other than L2 after verifying it (FD-CACHE-014). */
  readonly place: (entry: L2Entry) => Effect.Effect<boolean>;
  readonly usage: () => { readonly bytes: number; readonly cap: number; readonly entries: number };
}

/** The entry's one object, once its manifest verifies and every object hashes to its recorded digest. */
const verified = async (entry: L2Entry, keys: VerificationKeys): Promise<Uint8Array | null> => {
  if (!(await verifyManifest(entry.manifest, keys))) return null;
  for (const o of entry.manifest.objects) {
    const bytes = entry.objects.get(o.path);
    if (bytes === undefined || bytes.byteLength !== o.size || (await sha256Hex(bytes)) !== o.sha256) return null;
  }
  const first = entry.manifest.objects[0];
  return first === undefined ? null : (entry.objects.get(first.path) ?? null);
};

/**
 * Opens L1 on `disk`: the cap is the share of free disk measured now (FD-CACHE-009), and the index is rebuilt from
 * the files present.
 */
export const openL1 = async (options: L1Options): Promise<L1Cache> => {
  const now = options.now ?? Date.now;
  const cap = Math.floor((await options.disk.freeBytes()) * (options.share ?? 0.2));
  const index = new Map<string, Entry>();
  for (const f of await options.disk.list()) {
    const at = f.path.lastIndexOf("/");
    const namespace = f.path.slice(0, at);
    const key = f.path.slice(at + 1);
    if (safe(namespace, key)) index.set(f.path, { namespace, key, size: f.size, lastReadAt: 0 });
  }
  const total = () => [...index.values()].reduce((s, e) => s + e.size, 0);
  const evictLru = async (target: number) => {
    let freed = 0;
    for (const e of [...index.values()].sort((a, b) => a.lastReadAt - b.lastReadAt)) {
      if (freed >= target) break;
      await options.disk.remove(pathOf(e.namespace, e.key));
      index.delete(pathOf(e.namespace, e.key));
      freed += e.size;
    }
    return freed;
  };
  const store = async (namespace: string, key: string, bytes: Uint8Array) => {
    if (bytes.byteLength > cap) return false;
    const over = total() + bytes.byteLength - cap;
    if (over > 0) await evictLru(over);
    await options.disk.write(pathOf(namespace, key), bytes);
    index.set(pathOf(namespace, key), { namespace, key, size: bytes.byteLength, lastReadAt: now() });
    return true;
  };
  const l2Allowed = (namespace: string) =>
    options.offline?.() !== true && options.confidential?.(namespace) !== true;

  return {
    get: (namespace, key) =>
      Effect.tryPromise(async () => {
        if (!safe(namespace, key)) return null;
        const hit = index.get(pathOf(namespace, key));
        if (hit !== undefined) {
          const bytes = await options.disk.read(pathOf(namespace, key));
          if (bytes !== null) {
            hit.lastReadAt = now();
            return bytes;
          }
          index.delete(pathOf(namespace, key));
        }
        // FD-CACHE-006: a miss reads through to L2 and places the entry only once every digest verifies.
        if (!l2Allowed(namespace)) return null;
        const entry = await options.l2.fetch(namespace, key);
        if (entry === null || entry.manifest.key !== key || entry.manifest.namespace !== namespace) return null;
        const bytes = await verified(entry, options.keys);
        if (bytes === null) return null;
        await store(namespace, key, bytes);
        return bytes;
      }).pipe(Effect.orElseSucceed(() => null)),
    put: (namespace, key, bytes) =>
      Effect.gen(function* () {
        const digest = yield* Effect.promise(() => sha256Hex(bytes));
        if (!safe(namespace, key)) return digest;
        // FD-CACHE-007: L1 first, then the upload to L2; an upload failure is logged and the put stands.
        yield* Effect.tryPromise(() => store(namespace, key, bytes)).pipe(
          Effect.catchCause((cause) => Effect.logWarning("cache.l1_write_failed", cause).pipe(Effect.annotateLogs({ key }))),
        );
        if (l2Allowed(namespace))
          yield* Effect.tryPromise(() => options.l2.upload(namespace, key, bytes)).pipe(
            Effect.catchCause((cause) => Effect.logWarning("cache.l2_upload_failed", cause).pipe(Effect.annotateLogs({ key }))),
          );
        return digest;
      }),
    evict: (target) => Effect.promise(() => evictLru(target)),
    place: (entry) =>
      Effect.tryPromise(async () => {
        const { namespace, key } = entry.manifest;
        if (!safe(namespace, key)) return false;
        const bytes = await verified(entry, options.keys);
        return bytes === null ? false : store(namespace, key, bytes);
      }).pipe(Effect.orElseSucceed(() => false)),
    usage: () => ({ bytes: total(), cap, entries: index.size }),
  };
};

/** L1 on a directory of the local disk. */
export const nodeDisk = (root: string): L1Disk => {
  const abs = (p: string) => join(root, p);
  const walk = async (dir: string, prefix: string): Promise<{ path: string; size: number }[]> => {
    const out: { path: string; size: number }[] = [];
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return out;
    }
    for (const name of names) {
      const full = join(dir, name);
      const s = await stat(full);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      if (s.isDirectory()) out.push(...(await walk(full, rel)));
      else out.push({ path: rel, size: s.size });
    }
    return out;
  };
  return {
    read: async (p) => readFile(abs(p)).then((b) => new Uint8Array(b)).catch(() => null),
    write: async (p, bytes) => {
      await mkdir(dirname(abs(p)), { recursive: true });
      await writeFile(abs(p), bytes);
    },
    remove: (p) => rm(abs(p), { force: true }),
    list: () => walk(root, ""),
    freeBytes: async () => {
      await mkdir(root, { recursive: true });
      const s = await statfs(root);
      return s.bavail * s.bsize;
    },
  };
};

/** An in-memory disk with a fixed free size, for tests. */
export const memoryDisk = (free: number): L1Disk & { readonly files: Map<string, Uint8Array> } => {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    read: async (p) => files.get(p) ?? null,
    write: async (p, b) => void files.set(p, b),
    remove: async (p) => void files.delete(p),
    list: async () => [...files].map(([path, b]) => ({ path, size: b.byteLength })),
    freeBytes: async () => free,
  };
};

// ---- The extension interface ------------------------------------------------------------------

type Request =
  | { readonly type: "cache.get"; readonly id: string; readonly namespace: string; readonly key: string }
  | { readonly type: "cache.put"; readonly id: string; readonly namespace: string; readonly key: string; readonly bytes: string }
  | { readonly type: "cache.evict"; readonly id: string; readonly target_bytes: number };

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/**
 * Answers one cache request of mameko's device extension interface with its `.ok` message; bytes travel base64
 * (FD-CACHE-004, FD-CACHE-010).
 */
export const answerCacheRequest = (l1: L1Cache, request: Request) =>
  Effect.gen(function* () {
    const reply = { id: `${request.id}.ok`, ref: request.id };
    if (request.type === "cache.get") {
      const bytes = yield* l1.get(request.namespace, request.key);
      return { type: "cache.get.ok" as const, ...reply, bytes: bytes === null ? null : b64(bytes) };
    }
    if (request.type === "cache.put") {
      const digest = yield* l1.put(request.namespace, request.key, new Uint8Array(Buffer.from(request.bytes, "base64")));
      return { type: "cache.put.ok" as const, ...reply, digest: `sha256:${digest}` };
    }
    return { type: "cache.evict.ok" as const, ...reply, freed_bytes: yield* l1.evict(request.target_bytes) };
  });

// ---- Content tier and peers ---------------------------------------------------------------------

/**
 * A `content`-tier restore (FD-CACHE-030): the reader requests only a digest its own image manifest or lockfile
 * names, and the entry is a miss unless the restored bytes hash to it.
 */
export const restoreContent = (
  digest: string,
  trusted: ReadonlySet<string>,
  fetch: (digest: string) => Promise<Uint8Array | null>,
): Effect.Effect<Uint8Array | null> =>
  Effect.tryPromise(async () => {
    if (!/^[0-9a-f]{64}$/.test(digest) || !trusted.has(digest)) return null;
    const bytes = await fetch(digest);
    return bytes !== null && (await sha256Hex(bytes)) === digest ? bytes : null;
  }).pipe(Effect.orElseSucceed(() => null));

/** Another device of the same member, reached over the tailnet. */
export interface Peer {
  readonly member: string;
  readonly fetch: (namespace: string, key: string) => Promise<L2Entry | null>;
}

/**
 * Peer cache (FD-CACHE-014): where enabled, a miss may be fetched from another device of the same member, and the
 * entry is placed in L1 only once its manifest signature and every object digest verify.
 */
export const fetchFromPeers = (
  l1: L1Cache,
  member: string,
  peers: readonly Peer[],
  namespace: string,
  key: string,
  enabled: boolean,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!enabled) return false;
    for (const peer of peers) {
      if (peer.member !== member) continue;
      const entry = yield* Effect.tryPromise(() => peer.fetch(namespace, key)).pipe(Effect.orElseSucceed(() => null));
      if (entry === null || entry.manifest.namespace !== namespace || entry.manifest.key !== key) continue;
      if (yield* l1.place(entry)) return true;
    }
    return false;
  });
