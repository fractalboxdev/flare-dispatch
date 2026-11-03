// L1: the device extension's cache on the device's local disk, one directory per cache namespace, capped at a share of
// the free disk and evicting the least recently read entry first (specs/cache-artifacts.md § Model).
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** The cache namespace forms of the profile's `cache_namespaces` binding (specs/README.md § Glossary). */
const REPO = String.raw`[\w.-]+/[\w.-]+`;
const NAMESPACE = new RegExp(
  String.raw`^(protected/${REPO}/(cloud|device)|pr/${REPO}/[1-9]\d*|exec/${REPO}/[0-9A-HJKMNP-TV-Z]{26}|cas/[0-9a-f]{64})$`,
);

export const namespaceWellFormed = (namespace: string): boolean => NAMESPACE.test(namespace);

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

interface Entry {
  readonly namespace: string;
  readonly file: string;
  readonly bytes: number;
  lastRead: number;
}

/** The default share of the free disk measured at start that L1 may hold. */
export const DEFAULT_L1_SHARE = 0.2;

export const freeDiskBytes = (path: string): number => {
  const s = statfsSync(path);
  return Number(s.bavail) * Number(s.bsize);
};

export class L1 {
  private readonly entries = new Map<string, Entry>();
  private used = 0;
  private tick = 0;

  private readonly root: string;
  readonly capBytes: number;

  constructor(root: string, capBytes: number) {
    this.root = root;
    this.capBytes = capBytes;
    mkdirSync(root, { recursive: true });
    for (const dir of readdirSync(root)) {
      const namespace = decodeURIComponent(dir);
      for (const file of readdirSync(join(root, dir))) {
        const path = join(root, dir, file);
        const stat = statSync(path);
        this.entries.set(`${namespace}\0${file}`, {
          namespace,
          file: path,
          bytes: stat.size,
          lastRead: stat.mtimeMs,
        });
        this.used += stat.size;
      }
    }
    this.tick = Math.max(0, ...[...this.entries.values()].map((e) => e.lastRead));
  }

  private id(namespace: string, key: string) {
    return `${namespace}\0${sha256(key)}`;
  }

  get usedBytes() {
    return this.used;
  }

  get(namespace: string, key: string): Uint8Array | null {
    const entry = this.entries.get(this.id(namespace, key));
    if (entry === undefined) return null;
    entry.lastRead = ++this.tick;
    return new Uint8Array(readFileSync(entry.file));
  }

  /** Writes one entry, evicting the least recently read first when the write would exceed the cap. */
  put(namespace: string, key: string, bytes: Uint8Array): string {
    const id = this.id(namespace, key);
    this.remove(id);
    if (bytes.length > this.capBytes) return `sha256:${sha256(bytes)}`;
    this.evictUntil(this.capBytes - bytes.length);
    const dir = join(this.root, encodeURIComponent(namespace));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, sha256(key));
    writeFileSync(file, bytes);
    this.entries.set(id, { namespace, file, bytes: bytes.length, lastRead: ++this.tick });
    this.used += bytes.length;
    return `sha256:${sha256(bytes)}`;
  }

  /** Evicts least recently read entries until `target` bytes are freed or L1 is empty; answers the bytes freed. */
  evict(target: number): number {
    const before = this.used;
    this.evictUntil(Math.max(0, this.used - target));
    return before - this.used;
  }

  private evictUntil(limit: number) {
    const byAge = [...this.entries.entries()].sort((a, b) => a[1].lastRead - b[1].lastRead);
    for (const [id] of byAge) {
      if (this.used <= limit) break;
      this.remove(id);
    }
  }

  private remove(id: string) {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    rmSync(entry.file, { force: true });
    this.entries.delete(id);
    this.used -= entry.bytes;
  }
}
