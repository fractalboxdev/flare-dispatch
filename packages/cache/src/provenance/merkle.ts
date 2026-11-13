// The private transparency log's Merkle tree (specs/provenance.md § Countersignature and transparency log): RFC 9162
// leaf and node hashing, the tree head, inclusion proofs, the tiles the `TransparencyLog` object writes to R2, and the
// checkpoint the log key signs (FD-PROV-037).
//
// The writer keeps the stored hashes: the hash of every complete subtree, addressed by `(level, index)`, where the
// subtree at level `L` and index `i` covers leaves `[i·2^L, (i+1)·2^L)`. Every tree head and proof is computed from
// them. A tile is C2SP tlog-tiles' hash tile of height 8: tile level `L`, index `N`, width `W` holds the stored hashes
// of tree level `8L`, indices `256N` to `256N + W − 1`, concatenated. A full tile has width 256; a partial tile is
// written once per width it reaches, at its own path, so no tile object is ever rewritten.
import { asBuffer, utf8 } from "../crypto.ts";
import { fromBase64, signPae, type ProvenanceKey } from "./dsse.ts";

export const HASH_SIZE = 32;
/** C2SP tlog-tiles' tile height: 2^8 hashes per full tile. */
export const TILE_HEIGHT = 8;
export const TILE_WIDTH = 1 << TILE_HEIGHT;

const ES256 = { name: "ECDSA", hash: "SHA-256" } as const;
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", asBuffer(bytes)));

const prefixed = (prefix: number, ...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(1 + parts.reduce((n, p) => n + p.byteLength, 0));
  out[0] = prefix;
  let at = 1;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
};

/** RFC 9162 § 2.1.1: the hash of a leaf, `SHA-256(0x00 ‖ entry)`. */
export const leafHash = (entry: Uint8Array): Promise<Uint8Array> => sha256(prefixed(0x00, entry));

/** RFC 9162 § 2.1.1: the hash of an interior node, `SHA-256(0x01 ‖ left ‖ right)`. */
export const nodeHash = (left: Uint8Array, right: Uint8Array): Promise<Uint8Array> =>
  sha256(prefixed(0x01, left, right));

/** RFC 9162 § 2.1.1: the hash of the empty tree, `SHA-256()`. */
export const emptyTreeHash = (): Promise<Uint8Array> => sha256(new Uint8Array(0));

/** The largest power of two strictly below `n`, for `n > 1` (RFC 9162 § 2.1.1's `k`). */
const splitOf = (n: number): number => {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
};

const isPowerOfTwo = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;
const log2 = (n: number): number => Math.log2(n);

/** A stored hash: the hash of the complete subtree at `(level, index)`. */
export interface StoredHash {
  readonly level: number;
  readonly index: number;
  readonly hash: Uint8Array;
}

/** Reads the stored hash at `(level, index)`; the caller only asks for one the tree holds. */
export type ReadStoredHash = (level: number, index: number) => Uint8Array;

/**
 * The stored hashes that appending leaf `index` with hash `leaf` adds: the leaf itself at level 0, then each complete
 * subtree it closes. `read` answers the hashes stored before it.
 */
export const storedHashesForAppend = async (
  index: number,
  leaf: Uint8Array,
  read: ReadStoredHash,
): Promise<readonly StoredHash[]> => {
  const added: StoredHash[] = [{ level: 0, index, hash: leaf }];
  let hash = leaf;
  for (let level = 0; Math.floor(index / 2 ** level) % 2 === 1; level++) {
    const at = Math.floor(index / 2 ** level);
    hash = await nodeHash(read(level, at - 1), hash);
    added.push({ level: level + 1, index: Math.floor(at / 2), hash });
  }
  return added;
};

/**
 * RFC 9162's MTH over leaves `[start, end)`, from the stored hashes. Every range a tree head or a proof asks for starts
 * on a multiple of the largest power of two not above its length, so each complete piece is a stored hash.
 */
export const rangeHash = async (
  start: number,
  end: number,
  read: ReadStoredHash,
): Promise<Uint8Array> => {
  const n = end - start;
  if (n === 0) return emptyTreeHash();
  if (isPowerOfTwo(n) && start % n === 0) return read(log2(n), start / n);
  const k = splitOf(n);
  return nodeHash(await rangeHash(start, start + k, read), await rangeHash(start + k, end, read));
};

/** The root hash of the tree of the first `size` leaves (RFC 9162 § 2.1.1). */
export const treeHead = (size: number, read: ReadStoredHash): Promise<Uint8Array> =>
  rangeHash(0, size, read);

/** RFC 9162 § 2.1.3.1: the inclusion proof of leaf `index` in the tree of `size` leaves. */
export const inclusionProof = async (
  index: number,
  size: number,
  read: ReadStoredHash,
): Promise<readonly Uint8Array[]> => {
  const path = async (m: number, start: number, end: number): Promise<Uint8Array[]> => {
    const n = end - start;
    if (n <= 1) return [];
    const k = splitOf(n);
    return m < k
      ? [...(await path(m, start, start + k)), await rangeHash(start + k, end, read)]
      : [...(await path(m - k, start + k, end)), await rangeHash(start, start + k, read)];
  };
  return path(index, 0, size);
};

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);

/** RFC 9162 § 2.1.3.2: whether `proof` proves the leaf hash `leaf` at `index` in the tree of `size` leaves with `root`. */
export const verifyInclusion = async (
  index: number,
  size: number,
  leaf: Uint8Array,
  proof: readonly Uint8Array[],
  root: Uint8Array,
): Promise<boolean> => {
  if (index >= size) return false;
  let fn = index;
  let sn = size - 1;
  let r = leaf;
  for (const p of proof) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = await nodeHash(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = await nodeHash(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && equalBytes(r, root);
};

// ---- R2 layout ----

/** C2SP tlog-tiles' index encoding: 3-digit groups, every group but the last prefixed `x` (1234067 → x001/x234/067). */
export const encodeTileIndex = (n: number): string => {
  const groups: string[] = [];
  let rest = n;
  do {
    groups.unshift(String(rest % 1000).padStart(3, "0"));
    rest = Math.floor(rest / 1000);
  } while (rest > 0);
  return groups.map((g, i) => (i < groups.length - 1 ? `x${g}` : g)).join("/");
};

/** A hash tile: tile level `level`, index `index`, holding `width` hashes of tree level `TILE_HEIGHT · level`. */
export interface Tile {
  readonly level: number;
  readonly index: number;
  readonly width: number;
}

/** The tile's path under the log's prefix: `tile/<L>/<N>` for a full tile, `tile/<L>/<N>.p/<W>` for a partial one. */
export const tilePath = ({ level, index, width }: Tile): string =>
  `tile/${level}/${encodeTileIndex(index)}${width === TILE_WIDTH ? "" : `.p/${width}`}`;

/** The path of leaf `index`'s entry under the log's prefix. */
export const leafPath = (index: number): string => `leaf/${encodeTileIndex(index)}`;

/** The path of the latest checkpoint under the log's prefix. */
export const CHECKPOINT_PATH = "checkpoint";

/**
 * The tiles a tree of `size` leaves has that a tree of `from` leaves lacks: every full tile completed since, and the
 * partial tile at each level whose width grew.
 */
export const newTiles = (from: number, size: number): readonly Tile[] => {
  const tiles: Tile[] = [];
  for (let level = 0; Math.floor(size / TILE_WIDTH ** level) > 0; level++) {
    const before = Math.floor(from / TILE_WIDTH ** level);
    const after = Math.floor(size / TILE_WIDTH ** level);
    if (after === before) continue;
    for (
      let index = Math.floor(before / TILE_WIDTH);
      index < Math.floor(after / TILE_WIDTH);
      index++
    )
      tiles.push({ level, index, width: TILE_WIDTH });
    if (after % TILE_WIDTH > 0)
      tiles.push({ level, index: Math.floor(after / TILE_WIDTH), width: after % TILE_WIDTH });
  }
  return tiles;
};

/** A tile's bytes: its stored hashes, concatenated. */
export const tileBytes = (tile: Tile, read: ReadStoredHash): Uint8Array => {
  const out = new Uint8Array(tile.width * HASH_SIZE);
  for (let i = 0; i < tile.width; i++)
    out.set(read(tile.level * TILE_HEIGHT, tile.index * TILE_WIDTH + i), i * HASH_SIZE);
  return out;
};

// ---- Checkpoints ----

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

/** A checkpoint's body (C2SP tlog-checkpoint): the origin, the tree size and the root hash, one per line. */
export interface Checkpoint {
  readonly origin: string;
  readonly size: number;
  readonly root: Uint8Array;
}

export const checkpointBody = ({ origin, size, root }: Checkpoint): string =>
  `${origin}\n${size}\n${toBase64(root)}\n`;

/**
 * The signed checkpoint: the body, a blank line, and one signature line `— <kid> <signature>` by the log key, an ES256
 * P1363 signature over the body's bytes, standard base64.
 */
export const signCheckpoint = async (
  checkpoint: Checkpoint,
  key: ProvenanceKey,
): Promise<string> => {
  const body = checkpointBody(checkpoint);
  const { sig } = await signPae(key, utf8(body));
  return `${body}\n— ${key.kid} ${sig}\n`;
};

/** A signed checkpoint as published: its body's fields and its signature lines. */
export interface SignedCheckpoint extends Checkpoint {
  readonly body: string;
  readonly signatures: ReadonlyArray<{ readonly kid: string; readonly sig: string }>;
}

/** Parses a signed checkpoint, or answers `undefined` when the text is not one. */
export const parseCheckpoint = (text: string): SignedCheckpoint | undefined => {
  const split = text.indexOf("\n\n");
  if (split < 0) return undefined;
  const body = text.slice(0, split + 1);
  const [origin, size, root, ...rest] = body.split("\n");
  const rootBytes = root === undefined ? undefined : fromBase64(root);
  if (
    origin === undefined ||
    origin === "" ||
    size === undefined ||
    !/^(0|[1-9][0-9]*)$/.test(size) ||
    rootBytes?.byteLength !== HASH_SIZE ||
    rest.length !== 1 ||
    rest[0] !== ""
  )
    return undefined;
  const signatures = text
    .slice(split + 2)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => /^— (\S+) (\S+)$/.exec(line))
    .map((m) => (m === null ? undefined : { kid: m[1]!, sig: m[2]! }));
  if (signatures.some((s) => s === undefined)) return undefined;
  return {
    origin,
    size: Number(size),
    root: rootBytes,
    body,
    signatures: signatures as ReadonlyArray<{ kid: string; sig: string }>,
  };
};

/** Whether the checkpoint carries a valid signature by the public log key `publicJwk` under its `kid`. */
export const verifyCheckpoint = async (
  checkpoint: SignedCheckpoint,
  publicJwk: JsonWebKey & { readonly kid: string },
): Promise<boolean> => {
  const line = checkpoint.signatures.find((s) => s.kid === publicJwk.kid);
  const sig = line === undefined ? undefined : fromBase64(line.sig);
  if (sig === undefined) return false;
  try {
    const { kty, crv, x, y } = publicJwk;
    const key = await crypto.subtle.importKey("jwk", { kty, crv, x, y }, P256, false, ["verify"]);
    return await crypto.subtle.verify(ES256, key, asBuffer(sig), asBuffer(utf8(checkpoint.body)));
  } catch {
    return false;
  }
};

/** Whether two hashes are equal. */
export const sameHash = equalBytes;
