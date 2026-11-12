// The private transparency log's writer logic (FD-PROV-037, FD-PROV-038, FD-PROV-074), run by the `TransparencyLog`
// Durable Object (log-object.ts) over its SQLite storage and the R2 bucket:
//
//   tlog_leaves   idx (the leaf index the object assigns), entry_digest, leaf_hash, integrated_at
//   tlog_hashes   (level, idx) → the hash of each complete subtree (merkle.ts § stored hashes)
//   tlog_meta     signed_size, signed_at: the tree size of the last checkpoint the object signed
//
//   <prefix>leaf/<N>             each leaf's entry bytes
//   <prefix>tile/<L>/<N>[.p/<W>] C2SP tlog-tiles hash tiles
//   <prefix>checkpoint           the latest checkpoint, signed by the log key
//
// Every leaf and tile is written once, with a create-only `onlyIf` put. An append assigns the next index, writes the
// leaf and records it; the checkpoint run writes the new tiles and signs the checkpoint. A write that would change an
// existing leaf or tile, or a checkpoint that would reduce the published tree size or change its root, is refused,
// and the writer raises the `private-log-refused` page alarm (FD-PROV-038).
import { AlarmPort } from "@fractalboxdev/mameko-ports";
import { Data, Effect, Layer, Schema } from "effect";
import { hex, sha256Hex } from "../crypto.ts";
import type { Bucket } from "../manifest.ts";
import type { ProvenanceKey } from "./dsse.ts";
import {
  CHECKPOINT_PATH,
  leafHash,
  leafPath,
  newTiles,
  parseCheckpoint,
  sameHash,
  signCheckpoint,
  storedHashesForAppend,
  tileBytes,
  tilePath,
  treeHead,
  type ReadStoredHash,
} from "./merkle.ts";

/** How long after an append the object's alarm signs the checkpoint: well inside FD-PROV-037's 60 s. */
export const CHECKPOINT_DELAY_MS = 2_000;

/** FD-PROV-037's bound: a checkpoint covering an append is signed no later than this after it. */
export const CHECKPOINT_BOUND_MS = 60_000;

/** The R2 prefix the private log's objects live under, in the control plane's `CACHE` bucket. */
export const PRIVATE_LOG_PREFIX = "tlog/private/";

/** The name of the one `TransparencyLog` object. */
export const PRIVATE_LOG_NAME = "private";

/** The page alarm a refused private-log write raises (FD-PROV-038). */
export const PRIVATE_LOG_REFUSED_ALARM = "private-log-refused";

/** Why the object refused a private-log write. */
export type RefusalReason =
  /** A leaf object already exists at the assigned index with other bytes. */
  | "leaf-changed"
  /** A tile object already exists at its path with other bytes. */
  | "tile-changed"
  /** The published checkpoint's tree is larger than the object's: signing would reduce the tree size. */
  | "tree-size-reduced"
  /** The published checkpoint's root differs from the object's root at that size: an existing leaf would change. */
  | "root-changed"
  /** The published checkpoint changed under the object's write. */
  | "checkpoint-changed";

export class PrivateLogWriteRefused extends Schema.TaggedError<PrivateLogWriteRefused>()(
  "PrivateLogWriteRefused",
  { reason: Schema.String, path: Schema.String, detail: Schema.Unknown },
) {}

export class PrivateLogStoreFailed extends Schema.TaggedError<PrivateLogStoreFailed>()(
  "PrivateLogStoreFailed",
  { path: Schema.String, message: Schema.String },
) {}

export class LogKeyMissing extends Schema.TaggedError<LogKeyMissing>()("LogKeyMissing", {
  message: Schema.String,
}) {}

/** What an append answers. */
export type AppendOutcome = Data.TaggedEnum<{
  /** The entry is leaf `index`; `duplicate` when an earlier append of the same bytes assigned it. */
  Appended: {
    readonly index: number;
    readonly leafHash: string;
    readonly integratedAt: number;
    readonly duplicate: boolean;
  };
  /** The write would change the log; nothing was recorded and the page alarm was raised. */
  Refused: { readonly reason: RefusalReason; readonly path: string };
}>;
export const AppendOutcome = Data.taggedEnum<AppendOutcome>();

/** What a checkpoint run answers. */
export type CheckpointOutcome = Data.TaggedEnum<{
  Published: { readonly size: number; readonly root: string; readonly signedAt: number };
  /** Every leaf is already under a signed checkpoint. */
  Unchanged: { readonly size: number };
  Refused: { readonly reason: RefusalReason; readonly path: string };
}>;
export const CheckpointOutcome = Data.taggedEnum<CheckpointOutcome>();

/** What the object writes with. */
export interface TransparencyLogConfig {
  readonly bucket: Bucket;
  /** The R2 prefix of the log's objects, ending in `/`. */
  readonly prefix: string;
  /** The checkpoint's origin line. */
  readonly origin: string;
  /** The log key, or `undefined` while the deploy holds none: then no checkpoint is signed. */
  readonly logKey: ProvenanceKey | undefined;
  readonly alarms: Layer.Layer<AlarmPort>;
}

const SCHEMA = [
  `create table if not exists tlog_leaves (
     idx integer primary key,
     entry_digest text not null unique,
     leaf_hash text not null,
     integrated_at integer not null)`,
  `create table if not exists tlog_hashes (
     level integer not null,
     idx integer not null,
     hash text not null,
     primary key (level, idx))`,
  "create table if not exists tlog_meta (k text primary key, v integer not null)",
];

const fromHex = (text: string): Uint8Array =>
  Uint8Array.from(text.match(/../g) ?? [], (byte) => parseInt(byte, 16));

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);

/** The private log's state in the object's SQLite storage. */
export const logStore = (sql: SqlStorage) => {
  for (const statement of SCHEMA) sql.exec(statement);
  const read: ReadStoredHash = (level, index) => {
    const rows = sql
      .exec<{ hash: string }>(
        "select hash from tlog_hashes where level = ? and idx = ?",
        level,
        index,
      )
      .toArray();
    const row = rows[0];
    // A stored hash merkle.ts asks for is one the tree holds; its absence is a broken store, not a refusal.
    if (row === undefined) throw new Error(`stored hash (${level}, ${index}) is missing`);
    return fromHex(row.hash);
  };
  const meta = (k: string): number | undefined =>
    sql.exec<{ v: number }>("select v from tlog_meta where k = ?", k).toArray()[0]?.v;
  return {
    read,
    size: (): number => sql.exec<{ n: number }>("select count(*) as n from tlog_leaves").one().n,
    byDigest: (digest: string) =>
      sql
        .exec<{ idx: number; leaf_hash: string; integrated_at: number }>(
          "select idx, leaf_hash, integrated_at from tlog_leaves where entry_digest = ?",
          digest,
        )
        .toArray()[0],
    record: (
      leaf: {
        readonly index: number;
        readonly digest: string;
        readonly hash: Uint8Array;
        readonly at: number;
      },
      hashes: ReadonlyArray<{
        readonly level: number;
        readonly index: number;
        readonly hash: Uint8Array;
      }>,
    ) => {
      sql.exec(
        "insert into tlog_leaves (idx, entry_digest, leaf_hash, integrated_at) values (?, ?, ?, ?)",
        leaf.index,
        leaf.digest,
        hex(leaf.hash),
        leaf.at,
      );
      for (const h of hashes)
        sql.exec(
          "insert into tlog_hashes (level, idx, hash) values (?, ?, ?)",
          h.level,
          h.index,
          hex(h.hash),
        );
    },
    signedSize: (): number => meta("signed_size") ?? 0,
    signed: (size: number, at: number) => {
      sql.exec("insert or replace into tlog_meta (k, v) values ('signed_size', ?)", size);
      sql.exec("insert or replace into tlog_meta (k, v) values ('signed_at', ?)", at);
    },
  };
};
export type LogStore = ReturnType<typeof logStore>;

const storeFailed = (path: string) => (e: unknown) =>
  new PrivateLogStoreFailed({ path, message: e instanceof Error ? e.message : String(e) });

/**
 * A create-only put: `created` when no object was at `key`, `same` when one with these bytes already was (a retried
 * write), and `different` when one with other bytes was, which the caller refuses.
 */
const putCreateOnly = (bucket: Bucket, key: string, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const put = yield* Effect.tryPromise({
      try: () => bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" } }),
      catch: storeFailed(key),
    });
    if (put !== null) return "created" as const;
    const existing = yield* Effect.tryPromise({
      try: async () => {
        const object = await bucket.get(key);
        return object === null ? null : new Uint8Array(await object.arrayBuffer());
      },
      catch: storeFailed(key),
    });
    if (existing === null)
      return yield* new PrivateLogStoreFailed({ path: key, message: "the object vanished" });
    return sameBytes(existing, bytes) ? ("same" as const) : ("different" as const);
  });

const refuse = (reason: RefusalReason, path: string, detail: unknown) =>
  Effect.fail(new PrivateLogWriteRefused({ reason, path, detail }));

/** Raises the `private-log-refused` page alarm for a refused write; an undelivered alarm is logged. */
const pageRefusal = (config: TransparencyLogConfig, refused: PrivateLogWriteRefused) =>
  Effect.gen(function* () {
    const alarms = yield* AlarmPort;
    yield* alarms
      .deliver({
        name: PRIVATE_LOG_REFUSED_ALARM,
        severity: "page",
        dedupeKey: `${PRIVATE_LOG_REFUSED_ALARM}:${config.origin}`,
        state: "raised",
        detail: {
          origin: config.origin,
          reason: refused.reason,
          path: refused.path,
          detail: refused.detail,
        },
      })
      .pipe(
        Effect.catchTag("AlarmDeliveryFailed", (e) =>
          Effect.logWarning("private-log-refused alarm undelivered", e.reason),
        ),
      );
    yield* Effect.logError("private log write refused", refused.reason, refused.path);
  }).pipe(Effect.provide(config.alarms));

/** Appends `entry` as the next leaf, or answers its earlier index when the same bytes were appended before. */
export const appendEntry = (
  store: LogStore,
  config: TransparencyLogConfig,
  entry: Uint8Array,
  now: number,
) =>
  Effect.gen(function* () {
    const digest = yield* Effect.promise(() => sha256Hex(entry));
    const earlier = store.byDigest(digest);
    if (earlier !== undefined)
      return AppendOutcome.Appended({
        index: earlier.idx,
        leafHash: earlier.leaf_hash,
        integratedAt: earlier.integrated_at,
        duplicate: true,
      });
    const index = store.size();
    const hash = yield* Effect.promise(() => leafHash(entry));
    const hashes = yield* Effect.promise(() => storedHashesForAppend(index, hash, store.read));
    const path = `${config.prefix}${leafPath(index)}`;
    if ((yield* putCreateOnly(config.bucket, path, entry)) === "different")
      return yield* refuse("leaf-changed", path, { index });
    store.record({ index, digest, hash, at: now }, hashes);
    return AppendOutcome.Appended({
      index,
      leafHash: hex(hash),
      integratedAt: now,
      duplicate: false,
    });
  });

/**
 * Signs a checkpoint over every recorded leaf: checks the published checkpoint is a prefix of the object's tree,
 * writes the tiles the growth adds, then replaces the checkpoint with one signed by the log key.
 */
export const publishCheckpoint = (store: LogStore, config: TransparencyLogConfig, now: number) =>
  Effect.gen(function* () {
    const size = store.size();
    const path = `${config.prefix}${CHECKPOINT_PATH}`;
    const object = yield* Effect.tryPromise({
      try: async () => {
        const got = await config.bucket.get(path);
        return got === null ? null : { etag: got.etag, text: await got.text() };
      },
      catch: storeFailed(path),
    });
    const published = object === null ? undefined : parseCheckpoint(object.text);
    if (object !== null && published === undefined)
      return yield* refuse("checkpoint-changed", path, {
        message: "the published checkpoint does not parse",
      });
    if (published !== undefined) {
      if (published.size > size)
        return yield* refuse("tree-size-reduced", path, { published: published.size, size });
      const root = yield* Effect.promise(() => treeHead(published.size, store.read));
      if (!sameHash(root, published.root))
        return yield* refuse("root-changed", path, { size: published.size });
    }
    const from = published?.size ?? 0;
    if (size === 0 || (from === size && store.signedSize() === size))
      return CheckpointOutcome.Unchanged({ size });
    for (const tile of newTiles(from, size)) {
      const at = `${config.prefix}${tilePath(tile)}`;
      if ((yield* putCreateOnly(config.bucket, at, tileBytes(tile, store.read))) === "different")
        return yield* refuse("tile-changed", at, tile);
    }
    const key = config.logKey;
    if (key === undefined)
      return yield* new LogKeyMissing({
        message: "the deploy holds no LOG_KEY; no checkpoint is signed",
      });
    const root = yield* Effect.promise(() => treeHead(size, store.read));
    const text = yield* Effect.promise(() =>
      signCheckpoint({ origin: config.origin, size, root }, key),
    );
    const put = yield* Effect.tryPromise({
      try: () =>
        config.bucket.put(path, text, {
          onlyIf: object === null ? { etagDoesNotMatch: "*" } : { etagMatches: object.etag },
          httpMetadata: { contentType: "text/plain; charset=utf-8" },
        }),
      catch: storeFailed(path),
    });
    if (put === null) return yield* refuse("checkpoint-changed", path, { size });
    store.signed(size, now);
    return CheckpointOutcome.Published({ size, root: hex(root), signedAt: now });
  });

/** A refused write answers its outcome after raising the page alarm. */
export const refusedOutcome =
  (config: TransparencyLogConfig) => (refused: PrivateLogWriteRefused) =>
    Effect.as(pageRefusal(config, refused), {
      _tag: "Refused" as const,
      reason: refused.reason as RefusalReason,
      path: refused.path,
    });

/** The one `TransparencyLog` object of a `TRANSPARENCY_LOG` namespace. */
export const privateLogOf = <T>(namespace: {
  idFromName(name: string): unknown;
  get(id: never): T;
}): T => namespace.get(namespace.idFromName(PRIVATE_LOG_NAME) as never);
