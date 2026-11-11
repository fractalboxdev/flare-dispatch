// The cache, artifact and log area on the Worker: a lease's cache fields, the compile-cache route, the log and artifact
// reads the router serves behind the link surface (FD-IFC-017), and the retention sweeps the minute tick runs. The
// compile-cache route checks its own token (FD-CACHE-057).
import {
  apiError,
  errorBody,
  FlareDispatchApi,
  type ApiError,
  type ArtifactsPage,
} from "@fractalboxdev/flare-dispatch-api";
import {
  ARTIFACT_PAGE_SIZE,
  ARTIFACT_SCHEMA,
  artifactPage,
  findArtifact,
  handleCompileCache,
  ledgersOf,
  serveArtifact,
  serveLogs,
  sweepArtifacts,
  sweepCache,
  sweepLogs,
} from "@fractalboxdev/flare-dispatch-cache";
import type { IntakeRecord } from "@fractalboxdev/flare-dispatch-intake";
import type { TickStep } from "@fractalboxdev/flare-dispatch-ops";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare";
import { Context, Effect, Layer, Match } from "effect";
import { HttpServerResponse, type HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import type { ControlPlaneEnv } from "./config.ts";
import { leaseCacheAt, type LeaseOf } from "./cache-execution.ts";

/** The bindings this area reads beside the control plane's. */
export interface CacheEnv {
  /** The one bucket: `cache/`, `compile-cache/`, `artifacts/` and `logs/` (FD-CACHE-091). */
  readonly CACHE?: R2Bucket;
  /** One `CacheLedger` object per repository. */
  readonly CACHE_LEDGER?: DurableObjectNamespace;
  /** The secret compile-cache tokens derive from (FD-CACHE-057). */
  readonly COMPILE_CACHE_SECRET?: string;
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

/**
 * A lease's `cache_namespaces` and `upload_grant`, from the won placement's epoch and executor kind; no URL outlives the
 * execution's `deadline_at` as admission wrote it.
 */
export const leaseCache = async (
  env: ControlPlaneEnv & CacheEnv,
  record: IntakeRecord,
  deadlineAt: number,
) => {
  const placement = await first<LeaseOf>(
    env.DB,
    `select p.epoch, x.kind from placements p left join executors x on x.executor_id = p.executor_id
     where p.execution_id = ?`,
    record.executionId,
  );
  return leaseCacheAt(env, record, placement ?? { epoch: 1, kind: null }, deadlineAt);
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

/** A binding this deploy lacks answers `unavailable` in the error model's shape (FD-IFC-009). */
const unavailable = (what: string) =>
  Response.json(errorBody(apiError("unavailable", what), crypto.randomUUID()), { status: 503 });

const executionStatus = (db: D1Like, id: string) =>
  first<{ status: string; epoch: number | null; executor_id: string | null }>(
    db,
    `select e.status, p.epoch, p.executor_id from executions e left join placements p on p.execution_id = e.id
     where e.id = ?`,
    id,
  );

const isTerminal = (s: { readonly status: string }) =>
  s.status !== "pending" && s.status !== "running";

/** Serves a compile-cache route, or answers null for a path this area does not serve. */
export const cacheFetch = async (
  request: Request,
  env: ControlPlaneEnv & CacheEnv,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Response | null> => {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/v1/compile-cache/")) return null;
  const bucket = env.CACHE;
  if (bucket === undefined) return unavailable("this deploy binds no CACHE bucket");
  if (env.CACHE_LEDGER === undefined) return unavailable("this deploy binds no CACHE_LEDGER");
  return handleCompileCache(request, {
    bucket,
    ledgers: ledgersOf(env.CACHE_LEDGER),
    secret: env.COMPILE_CACHE_SECRET,
    now: Date.now,
    waitUntil,
    lease: async (id) => {
      const s = await executionStatus(env.DB, id);
      return s === undefined || s.epoch === null
        ? null
        : { epoch: s.epoch, terminal: isTerminal(s) };
    },
  });
};

// --- Log and artifact reads behind the router -------------------------------------------------------------------------

/**
 * The log and artifact reads the router's handlers call once the gate has identified the caller: an Access identity
 * or a link token bound to the execution or artifact (FD-IFC-017). Each answers an error from the error model.
 */
export class CacheReads extends Context.Service<
  CacheReads,
  {
    readonly logs: (
      request: Request,
      executionId: string,
      file: string | undefined,
    ) => Effect.Effect<Response, ApiError>;
    readonly artifact: (
      request: Request,
      artifactId: string,
      browsePath: string | undefined,
    ) => Effect.Effect<Response, ApiError>;
    readonly artifacts: (
      executionId: string,
      page: { readonly limit: number; readonly cursor: string },
    ) => Effect.Effect<typeof ArtifactsPage.Type, ApiError>;
  }
>()("@fractalboxdev/flare-dispatch-control-plane/CacheReads") {}

/** A deploy that binds no `CACHE` bucket has no log or artifact to read; each read answers `unavailable`. */
const cacheReadsUnbound = Layer.succeed(CacheReads)({
  logs: () => Effect.fail(apiError("unavailable", "this deploy binds no CACHE bucket")),
  artifact: () => Effect.fail(apiError("unavailable", "this deploy binds no CACHE bucket")),
  artifacts: () => Effect.fail(apiError("unavailable", "this deploy binds no CACHE bucket")),
});

/** The reads over the deploy's `CACHE` bucket and the artifact rows in D1. */
export const cacheReads = (env: ControlPlaneEnv & CacheEnv): Layer.Layer<CacheReads> => {
  const bucket = env.CACHE;
  if (bucket === undefined) return cacheReadsUnbound;
  const db = env.DB as unknown as D1Database;
  const terminal = async (id: string) => {
    const s = await executionStatus(env.DB, id);
    return s !== undefined && isTerminal(s);
  };
  const artifactDeps = { db, bucket, now: Date.now, terminal };
  const migrated = Effect.promise(() => migrateCache(env.DB));
  return Layer.succeed(CacheReads)({
    logs: (request, executionId, file) =>
      Effect.gen(function* () {
        const read = yield* Effect.promise(() =>
          serveLogs(
            request,
            { executionId, file },
            {
              bucket,
              execution: async (id) => {
                const s = await executionStatus(env.DB, id);
                return s === undefined
                  ? null
                  : {
                      terminal: isTerminal(s),
                      ...(s.executor_id === null ? {} : { executorId: s.executor_id }),
                    };
              },
            },
          ),
        );
        return yield* Match.value(read).pipe(
          Match.tagsExhaustive({
            Served: ({ response }) => Effect.succeed(response),
            NoExecution: () =>
              Effect.fail(apiError("execution_not_found", `no execution ${executionId}`)),
            NoFile: () => Effect.fail(apiError("not_found", "no such log file")),
          }),
        );
      }),
    artifact: (request, artifactId, browsePath) =>
      Effect.gen(function* () {
        yield* migrated;
        const row = yield* Effect.promise(() => findArtifact(artifactDeps, artifactId));
        if (row === null) return yield* apiError("not_found", `no artifact ${artifactId}`);
        const read = yield* Effect.promise(() =>
          serveArtifact(request, row, browsePath, artifactDeps),
        );
        return yield* Match.value(read).pipe(
          Match.tagsExhaustive({
            Served: ({ response }) => Effect.succeed(response),
            Missing: () => Effect.fail(apiError("not_found", "no such artifact file")),
            OnExecutor: ({ executorId }) =>
              Effect.fail(
                apiError("conflict", `artifact ${artifactId} is kept on executor ${executorId}`),
              ),
          }),
        );
      }),
    artifacts: (executionId, page) =>
      Effect.gen(function* () {
        yield* migrated;
        // The listing route admits only an Access identity of the team, which reads every repository's artifacts.
        return yield* Effect.promise(() =>
          artifactPage(artifactDeps, executionId, page, async () => true),
        );
      }),
  });
};

const response = (effect: Effect.Effect<Response, ApiError, CacheReads>) =>
  Effect.map(effect, (r) => HttpServerResponse.fromWeb(r));

const sourceOf = (request: HttpServerRequest.HttpServerRequest) => request.source as Request;

/** The logs group's handlers (FD-CACHE-083). */
export const LogsHandlers = HttpApiBuilder.group(FlareDispatchApi, "logs", (handlers) =>
  handlers
    .handle("aggregate", ({ params, request }) =>
      response(CacheReads.use((reads) => reads.logs(sourceOf(request), params.id, undefined))),
    )
    .handle("file", ({ params, request }) =>
      response(CacheReads.use((reads) => reads.logs(sourceOf(request), params.id, params.file))),
    ),
);

/** The artifacts group's handlers (FD-CACHE-075, FD-CACHE-078). */
export const ArtifactsHandlers = HttpApiBuilder.group(FlareDispatchApi, "artifacts", (handlers) =>
  handlers
    .handle("get", ({ params, request }) =>
      response(
        CacheReads.use((reads) =>
          reads.artifact(
            sourceOf(request),
            params.artifact_id,
            params["*"] === undefined || params["*"] === "" ? undefined : params["*"],
          ),
        ),
      ),
    )
    .handle("list", ({ params, query }) =>
      CacheReads.use((reads) =>
        reads.artifacts(params.id, {
          limit: query.limit ?? ARTIFACT_PAGE_SIZE,
          cursor: query.cursor ?? "",
        }),
      ),
    ),
);

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
