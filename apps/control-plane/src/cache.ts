// The cache, artifact and log area on the Worker: a lease's cache fields, the compile-cache, artifact and log routes,
// and the retention sweeps the minute tick runs. Every route checks its own token; a viewer with a valid Access
// identity of the team reads too.
import {
  ApiConfig,
  apiConfigFromEnv,
  authenticateAccess,
  ConfigInvalid,
  JwksSourceLive,
} from "@fractalboxdev/flare-dispatch-api";
import {
  ARTIFACT_SCHEMA,
  handleArtifacts,
  handleCompileCache,
  handleLogs,
  leaseCacheFields,
  ledgersOf,
  sweepArtifacts,
  sweepCache,
  sweepLogs,
} from "@fractalboxdev/flare-dispatch-cache";
import type { IntakeRecord } from "@fractalboxdev/flare-dispatch-intake";
import type { TickStep } from "@fractalboxdev/flare-dispatch-ops";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare";
import type { ExecutorKind } from "@fractalboxdev/mameko-kernel";
import { Effect } from "effect";
import type { ControlPlaneEnv } from "./config.ts";
import { cacheExecutionOf } from "./cache-execution.ts";
import { apiEnvOf } from "./http.ts";

/** The bindings this area reads beside the control plane's. */
export interface CacheEnv {
  /** The one bucket: `cache/`, `compile-cache/`, `artifacts/` and `logs/` (FD-CACHE-091). */
  readonly CACHE?: R2Bucket;
  /** One `CacheLedger` object per repository. */
  readonly CACHE_LEDGER?: DurableObjectNamespace;
  /** The secret compile-cache tokens derive from (FD-CACHE-057). */
  readonly COMPILE_CACHE_SECRET?: string;
  /** The secret log and artifact capability tokens derive from. */
  readonly CACHE_TOKEN_SECRET?: string;
  /** The public origin a compile-cache endpoint names. */
  readonly PUBLIC_ORIGIN?: string;
}

const TERMINAL = "status not in ('pending', 'running')";

const first = async <T>(db: D1Like, sql: string, ...binds: unknown[]): Promise<T | undefined> =>
  (
    await db
      .prepare(sql)
      .bind(...binds)
      .all()
  ).results[0] as T | undefined;

/** A lease's `cache_namespaces` and `upload_grant`, from the won placement's epoch and executor kind. */
export const leaseCache = async (env: ControlPlaneEnv & CacheEnv, record: IntakeRecord) => {
  const placement = await first<{ epoch: number; kind: ExecutorKind | null }>(
    env.DB,
    `select p.epoch, x.kind from placements p left join executors x on x.executor_id = p.executor_id
     where p.execution_id = ?`,
    record.executionId,
  );
  return leaseCacheFields(
    cacheExecutionOf(record),
    {
      epoch: placement?.epoch ?? 1,
      executorKind: placement?.kind ?? "device",
      deadlineAt: record.deadlineAtMs,
    },
    { publicOrigin: env.PUBLIC_ORIGIN, tokenSecret: env.COMPILE_CACHE_SECRET },
  );
};

/** Whether the request carries a valid Access identity of the team: any member reads an execution's logs. */
const viewer = (env: ControlPlaneEnv) => async (request: Request) => {
  const config = apiConfigFromEnv(apiEnvOf(env), new URL(request.url).origin);
  if (config instanceof ConfigInvalid) return false;
  const outcome = await Effect.runPromise(
    authenticateAccess(request, { redirectBrowser: false }).pipe(
      Effect.provideService(ApiConfig, config),
      Effect.provide(JwksSourceLive),
      Effect.orElseSucceed(() => null),
    ),
  );
  return outcome?._tag === "Access";
};

let artifactsMigrated: Promise<unknown> | undefined;

/** The artifact rows' table (FD-CACHE-073). */
export const migrateCache = (db: D1Like) =>
  (artifactsMigrated ??= (async () => {
    for (const sql of ARTIFACT_SCHEMA) await db.prepare(sql).run();
  })().catch((e: unknown) => {
    artifactsMigrated = undefined;
    throw e;
  }));

const unavailable = (what: string) =>
  Response.json({ error: "not_configured", message: what }, { status: 503 });

const ROUTES = /^\/v1\/(compile-cache\/|artifacts\/|executions\/[^/]+\/(logs|artifacts)(\/|$))/;

/** Serves a compile-cache, artifact or log route, or answers null for a path this area does not serve. */
export const cacheFetch = async (
  request: Request,
  env: ControlPlaneEnv & CacheEnv,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Response | null> => {
  const { pathname } = new URL(request.url);
  if (!ROUTES.test(pathname)) return null;
  const bucket = env.CACHE;
  if (bucket === undefined) return unavailable("this deploy binds no CACHE bucket");
  const status = async (id: string) =>
    first<{ status: string; epoch: number | null; executor_id: string | null }>(
      env.DB,
      `select e.status, p.epoch, p.executor_id from executions e left join placements p on p.execution_id = e.id
       where e.id = ?`,
      id,
    );
  const terminal = (s: { status: string }) => s.status !== "pending" && s.status !== "running";
  if (pathname.startsWith("/v1/compile-cache/")) {
    if (env.CACHE_LEDGER === undefined) return unavailable("this deploy binds no CACHE_LEDGER");
    return handleCompileCache(request, {
      bucket,
      ledgers: ledgersOf(env.CACHE_LEDGER),
      secret: env.COMPILE_CACHE_SECRET,
      now: Date.now,
      waitUntil,
      lease: async (id) => {
        const s = await status(id);
        return s === undefined || s.epoch === null
          ? null
          : { epoch: s.epoch, terminal: terminal(s) };
      },
    });
  }
  const secret = env.CACHE_TOKEN_SECRET;
  if (secret === undefined || secret === "")
    return unavailable("this deploy holds no CACHE_TOKEN_SECRET");
  const mayRead = viewer(env);
  if (/\/logs(\/|$)/.test(pathname))
    return handleLogs(request, {
      bucket,
      secret,
      now: Date.now,
      execution: async (id) => {
        const s = await status(id);
        return s === undefined
          ? null
          : {
              terminal: terminal(s),
              ...(s.executor_id === null ? {} : { executorId: s.executor_id }),
            };
      },
      viewerMayRead: (r) => mayRead(r),
    });
  await migrateCache(env.DB);
  return handleArtifacts(request, {
    db: env.DB as unknown as D1Database,
    bucket,
    secret,
    now: Date.now,
    terminal: async (id) => {
      const s = await status(id);
      return s !== undefined && terminal(s);
    },
    viewerMayRead: (r) => mayRead(r),
  });
};

/**
 * The retention sweeps (FD-CACHE-062 to FD-CACHE-066, FD-CACHE-079, FD-CACHE-089). No GitHub read answers when a pull
 * request closed, so a pull-request namespace ages out by its TTL alone; an execution with no settled reservation has
 * no end time, so its logs stay.
 */
export const cacheSweeps =
  (env: ControlPlaneEnv & CacheEnv) =>
  (now: number): readonly TickStep[] => {
    const bucket = env.CACHE;
    const ledger = env.CACHE_LEDGER;
    if (bucket === undefined || ledger === undefined) return [];
    return [
      {
        step: "cache-sweep",
        effect: Effect.promise(() =>
          sweepCache(bucket, now, {
            ledgers: ledgersOf(ledger),
            pullRequestClosedAt: async () => null,
          }),
        ),
      },
      {
        step: "artifact-sweep",
        effect: Effect.promise(async () => {
          await migrateCache(env.DB);
          return sweepArtifacts(env.DB as unknown as D1Database, bucket, now);
        }),
      },
      {
        step: "log-sweep",
        effect: Effect.promise(() =>
          sweepLogs(
            bucket,
            async (id) =>
              (
                await first<{ at: number | null }>(
                  env.DB,
                  `select r.updated_at as at from executions e join reservations r on r.execution_id = e.id
                 where e.id = ? and e.${TERMINAL} and r.state in ('settled', 'released')`,
                  id,
                )
              )?.at ?? null,
            now,
          ),
        ),
      },
    ];
  };
