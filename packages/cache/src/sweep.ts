// The cache sweep (specs/cache-artifacts.md § Retention and sweeps). One tick lists at most 500 pages of 1000 objects
// across `cache/` and then `compile-cache/`, and resumes from the cursor it stores in R2 (FD-CACHE-067). Listing is
// sorted by key, so the objects of one entry (`cache/<namespace>/<key>/`) are contiguous and one entry is held at a
// time. A tick that lists both prefixes whole from the start has seen every repository, so only such a tick evicts
// over-bound repositories and measures the `CacheLedger`; a partial tick releases what it deleted instead.
import { DEFAULT_LEDGER_BOUNDS, type CacheLedgers } from "./ledger.ts";
import { DEFAULT_CACHE_TTL_MS, type Bucket, type Manifest } from "./manifest.ts";
import { repoOfNamespace, tierOf } from "./namespaces.ts";

/** Run the sweep at least hourly (FD-CACHE-067). */
export const CACHE_SWEEP_CRON = "17 * * * *";
export const SWEEP_STATE_KEY = "sweep/cache-state";
export const MAX_SWEEP_PAGES = 500;
const HOUR = 3600 * 1000;

export interface CacheSweepOptions {
  readonly ledgers: CacheLedgers;
  /** When pull request `number` of `repo` closed, epoch ms, or `null` while it is open. */
  readonly pullRequestClosedAt: (repo: string, number: number) => Promise<number | null>;
  /** Default 14 days (FD-CACHE-062). */
  readonly ttlMs?: number;
  /** Default 20 GiB (FD-CACHE-063). */
  readonly repoBoundBytes?: number;
  /** Delay after a pull request closes, default 24 h (FD-CACHE-064). */
  readonly pullRequestDelayMs?: number;
  /** Age of an `exec/` namespace, default 7 days (FD-CACHE-065). */
  readonly executionNamespaceMs?: number;
  /** Age of an object no committed manifest lists, default 24 h (FD-CACHE-066). */
  readonly orphanMs?: number;
  readonly maxPages?: number;
}

interface Listed {
  readonly key: string;
  readonly size: number;
  readonly uploaded: number;
  readonly lastReadAt?: number;
}

/** One unit the sweep keeps or deletes: a committed entry, an orphan group, or a compile-cache object. */
interface Unit {
  readonly repo: string | undefined;
  readonly keys: readonly string[];
  readonly bytes: number;
  readonly lastReadAt: number;
  readonly committed: boolean;
}

export interface CacheSweepResult {
  readonly deletedObjects: number;
  readonly expired: number;
  readonly orphaned: number;
  readonly closedPullRequests: number;
  readonly evicted: number;
  /** Repositories the tick measured into the ledger, with their stored bytes. */
  readonly measured: Readonly<Record<string, number>>;
  readonly truncated: boolean;
}

const PHASES = ["cache/", "compile-cache/"] as const;

/** The namespace of an object key under `cache/` or `compile-cache/`. */
const namespaceOf = (key: string, prefix: string) => {
  const parts = key.slice(prefix.length).split("/");
  const width = parts[0] === "cas" ? 2 : 4;
  return parts.length > width ? parts.slice(0, width).join("/") : undefined;
};

export const sweepCache = async (
  bucket: Bucket,
  nowMs: number,
  options: CacheSweepOptions,
): Promise<CacheSweepResult> => {
  const ttl = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const bound = options.repoBoundBytes ?? DEFAULT_LEDGER_BOUNDS.maxRepoBytes;
  const prDelay = options.pullRequestDelayMs ?? 24 * HOUR;
  const execAge = options.executionNamespaceMs ?? 7 * 24 * HOUR;
  const orphanAge = options.orphanMs ?? 24 * HOUR;
  const maxPages = options.maxPages ?? MAX_SWEEP_PAGES;

  const state = await bucket.head(SWEEP_STATE_KEY);
  let phase = Number(state?.customMetadata?.phase ?? 0);
  let cursor = state?.customMetadata?.cursor;
  const fromStart = phase === 0 && cursor === undefined;

  const closed = new Map<string, number | null>();
  const prClosed = async (namespace: string) => {
    const parts = namespace.split("/");
    const repo = `${parts[1]}/${parts[2]}`;
    const id = `${repo}#${parts[3]}`;
    if (!closed.has(id)) closed.set(id, await options.pullRequestClosedAt(repo, Number(parts[3])));
    const at = closed.get(id);
    return at !== null && at !== undefined && nowMs - at > prDelay;
  };

  const doomed: string[] = [];
  const released = new Map<string, number>();
  const kept: Unit[] = [];
  const counts = { expired: 0, orphaned: 0, closedPullRequests: 0 };
  const drop = (unit: Unit, reason: keyof typeof counts) => {
    doomed.push(...unit.keys);
    counts[reason]++;
    if (unit.committed && unit.repo !== undefined)
      released.set(unit.repo, (released.get(unit.repo) ?? 0) + unit.bytes);
  };

  /** Decides one namespace-level rule, then the entry-level rules. */
  const decide = async (namespace: string, unit: Unit, created: number) => {
    const tier = tierOf(namespace);
    if (tier === "pull-request" && (await prClosed(namespace))) return drop(unit, "closedPullRequests");
    if (tier === "execution" && nowMs - created > execAge) return drop(unit, "expired");
    if (unit.committed && nowMs - unit.lastReadAt > ttl) return drop(unit, "expired");
    kept.push(unit);
  };

  // The first entry of a tick that resumed inside `cache/` may have started in the previous tick, so the sweep does
  // not judge its unlisted objects orphans.
  let resumedInside = phase === 0 && cursor !== undefined;
  let group:
    | { prefix: string; namespace: string; objects: Listed[]; partial: boolean }
    | undefined;
  const finishGroup = async () => {
    if (group === undefined) return;
    const { namespace, objects, prefix, partial } = group;
    group = undefined;
    const repo = repoOfNamespace(namespace);
    const manifestObject = objects.find((o) => o.key === `${prefix}manifest.json`);
    const created = Math.min(...objects.map((o) => o.uploaded));
    let listed = new Set<string>();
    if (manifestObject !== undefined) {
      const body = await bucket.get(manifestObject.key);
      const manifest = body === null ? null : (JSON.parse(await body.text()) as Manifest);
      listed = new Set(manifest?.objects.map((o) => o.path) ?? []);
    }
    const members = objects.filter((o) => o === manifestObject || listed.has(o.key));
    const orphans = objects.filter(
      (o) => o !== manifestObject && !listed.has(o.key) && nowMs - o.uploaded > orphanAge,
    );
    if (orphans.length > 0 && !partial)
      drop(
        { repo, keys: orphans.map((o) => o.key), bytes: 0, lastReadAt: 0, committed: false },
        "orphaned",
      );
    if (manifestObject !== undefined)
      await decide(
        namespace,
        {
          repo,
          keys: members.map((o) => o.key),
          bytes: members.reduce((s, o) => s + (o === manifestObject ? 0 : o.size), 0),
          lastReadAt: manifestObject.lastReadAt ?? manifestObject.uploaded,
          committed: true,
        },
        created,
      );
  };

  let pages = 0;
  let finished = false;
  while (pages < maxPages) {
    const prefix = PHASES[phase];
    if (prefix === undefined) {
      finished = true;
      break;
    }
    const page = await bucket.list({
      prefix,
      limit: 1000,
      include: ["customMetadata"],
      ...(cursor === undefined ? {} : { cursor }),
    });
    pages++;
    for (const o of page.objects) {
      const namespace = namespaceOf(o.key, prefix);
      if (namespace === undefined) continue;
      const lastRead = Number(o.customMetadata?.last_read_at);
      const item: Listed = {
        key: o.key,
        size: o.size,
        uploaded: o.uploaded.getTime(),
        ...(Number.isFinite(lastRead) ? { lastReadAt: lastRead } : {}),
      };
      if (prefix === "cache/") {
        const parts = o.key.slice(prefix.length).split("/");
        const width = parts[0] === "cas" ? 2 : 4;
        const entry = `${prefix}${parts.slice(0, width + 1).join("/")}/`;
        if (group?.prefix !== entry) {
          await finishGroup();
          group = { prefix: entry, namespace, objects: [], partial: resumedInside };
          resumedInside = false;
        }
        group.objects.push(item);
      } else {
        // A compile-cache object is visible as soon as it is written: its age is its time since its last read.
        await decide(
          namespace,
          {
            repo: repoOfNamespace(namespace),
            keys: [o.key],
            bytes: o.size,
            lastReadAt: item.uploaded,
            committed: true,
          },
          item.uploaded,
        );
      }
    }
    if (page.truncated) {
      cursor = page.cursor;
      continue;
    }
    await finishGroup();
    phase++;
    cursor = undefined;
  }
  if (!finished && PHASES[phase] === undefined) finished = true;
  // A group cut by the page bound resumes in the next tick, which lists the rest of it.
  if (!finished) group = undefined;

  const measured: Record<string, number> = {};
  let evicted = 0;
  if (finished && fromStart) {
    const byRepo = new Map<string, Unit[]>();
    for (const unit of kept)
      if (unit.repo !== undefined) byRepo.set(unit.repo, [...(byRepo.get(unit.repo) ?? []), unit]);
    for (const [repo, units] of byRepo) {
      let bytes = units.reduce((s, u) => s + u.bytes, 0);
      if (bytes > bound) {
        for (const unit of [...units].sort((a, b) => a.lastReadAt - b.lastReadAt)) {
          if (bytes <= Math.floor(bound * 0.9)) break;
          doomed.push(...unit.keys);
          bytes -= unit.bytes;
          evicted++;
        }
      }
      measured[repo] = bytes;
    }
    // A repository whose every entry the tick deleted holds nothing.
    for (const repo of released.keys()) measured[repo] ??= 0;
  }
  for (let i = 0; i < doomed.length; i += 1000) await bucket.delete(doomed.slice(i, i + 1000));
  if (finished && fromStart)
    for (const [repo, bytes] of Object.entries(measured))
      await options.ledgers(repo).measure({ bytes, nowMs });
  else
    for (const [repo, bytes] of released)
      await options.ledgers(repo).release({ bytes, nowMs });

  if (finished) {
    if (state !== null) await bucket.delete(SWEEP_STATE_KEY);
  } else
    await bucket.put(SWEEP_STATE_KEY, "", {
      customMetadata: { phase: String(phase), ...(cursor === undefined ? {} : { cursor }) },
    });
  return {
    deletedObjects: doomed.length,
    ...counts,
    evicted,
    measured,
    truncated: !finished,
  };
};
