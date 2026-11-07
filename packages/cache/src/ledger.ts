// The `CacheLedger`: one Durable Object per repository that reserves bytes before any write, so the per-execution and
// per-repository bounds hold at admission rather than as of the last sweep (FD-CACHE-052, FD-CACHE-054). The object
// runs one call at a time, so two reservations never both pass on the same headroom.
//
//   repo        { stored, pending }: committed bytes, and bytes reserved but not yet committed
//   x:<exec>    { reserved, pending, ended, expiresAt }: one execution's cumulative reservation, its uncommitted
//               part, whether it reached a terminal status, and when its record may be forgotten
//
// An overwritten compile-cache object counts twice until the sweep measures the repository; the count errs high.

/** The storage the ledger reads and writes: a Durable Object's `ctx.storage`, or a map in a test. */
export interface LedgerStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

export const GiB = 1024 * 1024 * 1024;
export const MiB = 1024 * 1024;

export interface LedgerBounds {
  /** Default 10 GiB. */
  readonly maxExecutionBytes: number;
  /** Default 20 GiB. */
  readonly maxRepoBytes: number;
}

export const DEFAULT_LEDGER_BOUNDS: LedgerBounds = {
  maxExecutionBytes: 10 * GiB,
  maxRepoBytes: 20 * GiB,
};

interface RepoRecord {
  readonly stored: number;
  readonly pending: number;
}
interface ExecutionRecord {
  readonly reserved: number;
  readonly pending: number;
  readonly ended: boolean;
  readonly expiresAt: number;
}

export interface ReserveRequest {
  readonly executionId: string;
  readonly bytes: number;
  /** Epoch ms after which the execution's record may be forgotten: its `deadline_at`. */
  readonly expiresAt: number;
  /** The write is visible at once (a compile-cache object), so the bytes count as stored, not pending. */
  readonly immediate?: boolean;
  readonly bounds?: LedgerBounds;
}

export type ReserveResult =
  | { readonly ok: true; readonly repoBytes: number }
  | {
      readonly ok: false;
      readonly reason: "ended" | "execution" | "repository";
      readonly repoBytes: number;
    };

/** The ledger's calls, as the presigner, the commit, the compile-cache route and the sweep make them. */
export interface CacheLedgerApi {
  reserve(request: ReserveRequest): Promise<ReserveResult>;
  /** A manifest or artifact commit turns `bytes` of the execution's pending reservation into stored bytes. */
  commit(request: { readonly executionId: string; readonly bytes: number }): Promise<void>;
  /** The execution reached a terminal status: refuse its later reservations and release its pending bytes. */
  end(request: {
    readonly executionId: string;
    readonly expiresAt: number;
  }): Promise<{ readonly released: number }>;
  /** The sweep deleted `bytes` of stored objects. */
  release(request: { readonly bytes: number; readonly nowMs: number }): Promise<number>;
  /** The sweep listed the whole repository: replace the stored count with the measured bytes. */
  measure(request: { readonly bytes: number; readonly nowMs: number }): Promise<number>;
  usage(): Promise<{ readonly stored: number; readonly pending: number }>;
}

const REPO = "repo";
const X = "x:";

export const makeCacheLedger = (storage: LedgerStorage): CacheLedgerApi => {
  const repo = async (): Promise<RepoRecord> =>
    (await storage.get<RepoRecord>(REPO)) ?? { stored: 0, pending: 0 };
  const forgetExpired = async (nowMs: number) => {
    const records = await storage.list<ExecutionRecord>({ prefix: X });
    for (const [key, record] of records)
      if (record.expiresAt <= nowMs && record.pending === 0) await storage.delete(key);
  };
  return {
    reserve: async (r) => {
      const bounds = r.bounds ?? DEFAULT_LEDGER_BOUNDS;
      const key = `${X}${r.executionId}`;
      const execution = (await storage.get<ExecutionRecord>(key)) ?? {
        reserved: 0,
        pending: 0,
        ended: false,
        expiresAt: r.expiresAt,
      };
      const totals = await repo();
      const repoBytes = totals.stored + totals.pending;
      if (execution.ended) return { ok: false, reason: "ended", repoBytes };
      if (execution.reserved + r.bytes > bounds.maxExecutionBytes)
        return { ok: false, reason: "execution", repoBytes };
      if (repoBytes + r.bytes > bounds.maxRepoBytes)
        return { ok: false, reason: "repository", repoBytes };
      await storage.put(key, {
        ...execution,
        reserved: execution.reserved + r.bytes,
        pending: execution.pending + (r.immediate === true ? 0 : r.bytes),
        expiresAt: Math.max(execution.expiresAt, r.expiresAt),
      });
      await storage.put(
        REPO,
        r.immediate === true
          ? { ...totals, stored: totals.stored + r.bytes }
          : { ...totals, pending: totals.pending + r.bytes },
      );
      return { ok: true, repoBytes: repoBytes + r.bytes };
    },
    commit: async ({ executionId, bytes }) => {
      const key = `${X}${executionId}`;
      const execution = await storage.get<ExecutionRecord>(key);
      if (execution === undefined) return;
      const moved = Math.min(bytes, execution.pending);
      await storage.put(key, { ...execution, pending: execution.pending - moved });
      const totals = await repo();
      await storage.put(REPO, {
        stored: totals.stored + moved,
        pending: Math.max(0, totals.pending - moved),
      });
    },
    end: async ({ executionId, expiresAt }) => {
      const key = `${X}${executionId}`;
      const execution = (await storage.get<ExecutionRecord>(key)) ?? {
        reserved: 0,
        pending: 0,
        ended: false,
        expiresAt,
      };
      const released = execution.pending;
      await storage.put(key, {
        ...execution,
        pending: 0,
        ended: true,
        expiresAt: Math.max(execution.expiresAt, expiresAt),
      });
      const totals = await repo();
      await storage.put(REPO, { ...totals, pending: Math.max(0, totals.pending - released) });
      return { released };
    },
    release: async ({ bytes, nowMs }) => {
      const totals = await repo();
      const stored = Math.max(0, totals.stored - bytes);
      await storage.put(REPO, { ...totals, stored });
      await forgetExpired(nowMs);
      return stored;
    },
    measure: async ({ bytes, nowMs }) => {
      const totals = await repo();
      await storage.put(REPO, { ...totals, stored: bytes });
      await forgetExpired(nowMs);
      return bytes;
    },
    usage: async () => repo(),
  };
};

/** An in-memory `LedgerStorage`, for tests and for a single-isolate fake. */
export const memoryStorage = (): LedgerStorage => {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => m.get(k) as T | undefined,
    put: async (k, v) => void m.set(k, v),
    delete: async (k) => m.delete(k),
    list: async <T>({ prefix }: { prefix: string }) =>
      new Map([...m].filter(([k]) => k.startsWith(prefix)) as [string, T][]),
  };
};

/** The ledger of a repository, by its lowercase `owner/name`. */
export type CacheLedgers = (repo: string) => CacheLedgerApi;

/** The ledgers over a `CACHE_LEDGER` Durable Object namespace, one object per repository. */
export const ledgersOf =
  (namespace: DurableObjectNamespace): CacheLedgers =>
  (repo) =>
    namespace.get(namespace.idFromName(repo.toLowerCase())) as unknown as CacheLedgerApi;

/** In-memory ledgers keyed by repository, for tests. */
export const memoryLedgers = (): CacheLedgers => {
  const ledgers = new Map<string, CacheLedgerApi>();
  return (repo) => {
    const key = repo.toLowerCase();
    const existing = ledgers.get(key);
    if (existing !== undefined) return existing;
    const created = makeCacheLedger(memoryStorage());
    ledgers.set(key, created);
    return created;
  };
};
