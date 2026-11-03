// Cache measurement (FD-CACHE-090): one D1 row per cache lookup with its level, cache tier, hit or miss and bytes
// restored, and per compile-cache GET; the dashboard reads the per-execution rows and the 28-day hit rate per cache
// tier and executor kind as data.
import type { CompileCacheLookup } from "./compile-cache.ts";
import { tierOf, type CacheTier } from "./namespaces.ts";

export const CACHE_LOOKUP_SCHEMA = [
  `create table if not exists cache_lookups (
    execution_id text not null,
    executor_kind text not null,
    level text not null check (level in ('L1', 'L2', 'compile-cache')),
    tier text,
    hit integer not null check (hit in (0, 1)),
    bytes integer not null,
    at integer not null
  )`,
  "create index if not exists cache_lookups_at on cache_lookups (at)",
  "create index if not exists cache_lookups_execution on cache_lookups (execution_id)",
] as const;

export const HIT_RATE_WINDOW_MS = 28 * 24 * 3600 * 1000;

export interface CacheLookup {
  readonly executionId: string;
  readonly executorKind: string;
  readonly level: "L1" | "L2" | "compile-cache";
  /** The tier of the namespace that answered; `null` for a miss, which no namespace answered. */
  readonly tier: CacheTier | null;
  readonly hit: boolean;
  /** Bytes restored; 0 on a miss. */
  readonly bytes: number;
  readonly at: number;
}

/** Records lookups, in batches D1 accepts. */
export const recordCacheLookups = async (db: D1Database, lookups: readonly CacheLookup[]) => {
  const insert = db.prepare(
    "insert into cache_lookups (execution_id, executor_kind, level, tier, hit, bytes, at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  );
  for (let i = 0; i < lookups.length; i += 50)
    await db.batch(
      lookups
        .slice(i, i + 50)
        .map((l) => insert.bind(l.executionId, l.executorKind, l.level, l.tier, l.hit ? 1 : 0, l.hit ? l.bytes : 0, l.at)),
    );
};

/** The row a compile-cache route lookup becomes, once the Worker knows the execution's executor kind. */
export const compileCacheLookupRow = (lookup: CompileCacheLookup, executorKind: string, at: number): CacheLookup => ({
  executionId: lookup.executionId,
  executorKind,
  level: "compile-cache",
  tier: lookup.namespace === null ? null : (tierOf(lookup.namespace) ?? null),
  hit: lookup.hit,
  bytes: lookup.bytes,
  at,
});

export interface ExecutionCacheColumns {
  readonly level: string;
  readonly tier: string | null;
  readonly lookups: number;
  readonly hits: number;
  readonly bytes_restored: number;
}

/** One execution's cache columns: lookups, hits and bytes restored per level and tier. */
export const executionCacheColumns = async (db: D1Database, executionId: string) =>
  (
    await db
      .prepare(
        `select level, tier, count(*) as lookups, sum(hit) as hits, sum(bytes) as bytes_restored
         from cache_lookups where execution_id = ? group by level, tier order by level, tier`,
      )
      .bind(executionId)
      .all<ExecutionCacheColumns>()
  ).results;

export interface HitRate {
  readonly executor_kind: string;
  readonly level: string;
  /** The tier the hits came from; misses have none, so each level's misses are counted on the `null` tier row. */
  readonly tier: string | null;
  readonly lookups: number;
  readonly hits: number;
  readonly hit_rate: number;
  readonly bytes_restored: number;
}

/**
 * The 28-day hit rate per executor kind and level, and the share of lookups each tier answered. A miss has no tier,
 * so `hit_rate` per tier is hits on that tier over every lookup of that executor kind and level.
 */
export const cacheHitRates = async (db: D1Database, nowMs: number): Promise<readonly HitRate[]> => {
  const since = nowMs - HIT_RATE_WINDOW_MS;
  const { results } = await db
    .prepare(
      `with totals as (
         select executor_kind, level, count(*) as lookups from cache_lookups where at > ?1 group by executor_kind, level
       )
       select l.executor_kind, l.level, l.tier, t.lookups, sum(l.hit) as hits, sum(l.bytes) as bytes_restored
       from cache_lookups l join totals t on t.executor_kind = l.executor_kind and t.level = l.level
       where l.at > ?1 group by l.executor_kind, l.level, l.tier order by l.executor_kind, l.level, l.tier`,
    )
    .bind(since)
    .all<Omit<HitRate, "hit_rate">>();
  return results.map((r) => ({ ...r, hits: Number(r.hits), hit_rate: r.lookups === 0 ? 0 : Number(r.hits) / r.lookups }));
};
