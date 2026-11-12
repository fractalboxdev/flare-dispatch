// The cache, artifact and log area on the Worker: a lease's cache fields, the compile-cache route, the log and artifact
// reads the router serves behind the link surface (FD-IFC-017), and the minute tick's steps (cache-retention.ts). The
// compile-cache route checks its own token (FD-CACHE-057). A private repository's artifact is read only by its link
// token's holder, an operator or the identity that dispatched its execution (FD-CACHE-076), and the listing writes
// each artifact it shows with a link token for that artifact (FD-CACHE-077). Each compile-cache GET is recorded as a
// cache lookup of its execution, under the executor kind of the execution's placement (FD-CACHE-090).
import {
  ApiConfig,
  apiError,
  artifactUrl,
  CurrentIdentity,
  errorBody,
  FlareDispatchApi,
  inGroup,
  type ApiError,
  type Identity,
} from "@fractalboxdev/flare-dispatch-api";
import {
  ARTIFACT_PAGE_SIZE,
  artifactPage,
  artifactVisible,
  compileCacheLookupRow,
  findArtifact,
  handleCompileCache,
  ledgersOf,
  recordCacheLookups,
  serveArtifact,
  serveLogs,
  type ArtifactReader,
  type CompileCacheLookup,
} from "@fractalboxdev/flare-dispatch-cache";
import type { IntakeRecord } from "@fractalboxdev/flare-dispatch-intake";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare";
import { Context, Effect, Layer, Match } from "effect";
import { HttpServerResponse, type HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import type { ControlPlaneEnv } from "./config.ts";
import { leaseCacheAt, type LeaseOf } from "./cache-execution.ts";
import { migrateCache } from "./cache-retention.ts";
import { confidentialCompute } from "./dev-repository.ts";

export { cacheSweeps, migrateCache } from "./cache-retention.ts";

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

const first = async <T>(db: D1Like, sql: string, ...binds: unknown[]): Promise<T | undefined> =>
  (
    await db
      .prepare(sql)
      .bind(...binds)
      .all()
  ).results[0] as T | undefined;

/**
 * A lease's `cache_namespaces` and `upload_grant`, from the won placement's epoch and executor kind; no URL outlives the
 * execution's `deadline_at` as admission wrote it. A sealed job sandbox's lease names no namespace and carries no
 * compile-cache endpoint or token (FD-GATE-110).
 */
export const leaseCache = async (
  env: ControlPlaneEnv & CacheEnv,
  record: IntakeRecord,
  deadlineAt: number,
  sealed = false,
) => {
  const placement = await first<LeaseOf>(
    env.DB,
    `select p.epoch, x.kind from placements p left join executors x on x.executor_id = p.executor_id
     where p.execution_id = ?`,
    record.executionId,
  );
  return leaseCacheAt(env, record, placement ?? { epoch: 1, kind: null }, deadlineAt, sealed);
};

/** A binding this deploy lacks answers `unavailable` in the error model's shape (FD-IFC-009). */
const unavailable = (what: string) =>
  Response.json(errorBody(apiError("unavailable", what), crypto.randomUUID()), { status: 503 });

/** An execution's status, its placement's epoch and executor, and the repository intake recorded it under. */
const executionStatus = (db: D1Like, id: string) =>
  first<{ status: string; epoch: number | null; executor_id: string | null; repo: string | null }>(
    db,
    `select e.status, p.epoch, p.executor_id, i.repo from executions e
       left join placements p on p.execution_id = e.id
       left join intake_records i on i.execution_id = e.id
     where e.id = ?`,
    id,
  );

const isTerminal = (s: { readonly status: string }) =>
  s.status !== "pending" && s.status !== "running";

/** The kind of the executor an execution is placed on, or `unregistered` when its executor has no row. */
const executorKindOf = async (db: D1Like, executionId: string) =>
  (
    await first<{ kind: string | null }>(
      db,
      `select x.kind from placements p left join executors x on x.executor_id = p.executor_id
       where p.execution_id = ?`,
      executionId,
    )
  )?.kind ?? "unregistered";

/**
 * Records one compile-cache GET as a `compile-cache` lookup of its execution (FD-CACHE-090). It runs after the response
 * and logs a failure instead of throwing, so a metrics write never turns a cache hit into a miss.
 */
export const recordCompileCacheLookup = async (
  db: D1Like,
  lookup: CompileCacheLookup,
  at: number,
): Promise<void> => {
  try {
    await migrateCache(db);
    const kind = await executorKindOf(db, lookup.executionId);
    await recordCacheLookups(db, [compileCacheLookupRow(lookup, kind, at)]);
  } catch (e) {
    console.error(`compile-cache lookup of ${lookup.executionId} not recorded: ${String(e)}`);
  }
};

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
    onLookup: (lookup) => waitUntil(recordCompileCacheLookup(env.DB, lookup, Date.now())),
    lease: async (id) => {
      const s = await executionStatus(env.DB, id);
      return s === undefined || s.epoch === null
        ? null
        : { epoch: s.epoch, terminal: isTerminal(s) };
    },
  });
};

// --- Log and artifact reads behind the router -------------------------------------------------------------------------

/** The caller of an artifact read, as the router's gate identified it, and whether it is an operator. */
export interface ArtifactViewer {
  readonly identity: Identity;
  readonly operator: boolean;
}

/** One page of an execution's artifacts, as the cache area lists them. */
type ArtifactListing = Awaited<ReturnType<typeof artifactPage>>;

/** The identity that dispatched an execution, as intake recorded its caller; null for a webhook or cron execution. */
const dispatcherOf = async (db: D1Like, executionId: string) =>
  (
    await first<{ caller: string | null }>(
      db,
      "select caller from intake_records where execution_id = ?",
      executionId,
    )
  )?.caller ?? null;

/**
 * Who reads a private repository's artifact (FD-CACHE-076): the holder of a link token bound to that artifact, an
 * operator, or the Access identity that dispatched the execution that produced it.
 */
export const artifactReader =
  (db: D1Like, viewer: ArtifactViewer): ArtifactReader =>
  async (row) =>
    Match.value(viewer.identity).pipe(
      Match.tagsExhaustive({
        Link: ({ purpose, objectId }) => purpose === "artifact" && objectId === row.artifact_id,
        Access: async ({ id }) =>
          viewer.operator ||
          (await dispatcherOf(db, row.execution_id))?.toLowerCase() === id.toLowerCase(),
        Actions: () => false,
        Unidentified: () => false,
      }),
    );

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
      viewer: ArtifactViewer,
    ) => Effect.Effect<Response, ApiError>;
    readonly artifacts: (
      executionId: string,
      page: { readonly limit: number; readonly cursor: string },
      viewer: ArtifactViewer,
    ) => Effect.Effect<ArtifactListing, ApiError>;
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
  const migratedDb = Effect.promise(() => migrateCache(env.DB));
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
                      // A `confidential-compute` repository's logs stay on the device: the viewer shows a pointer
                      // and fetches no log content (FD-CACHE-088).
                      confidential: s.repo !== null && confidentialCompute(env, s.repo),
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
    artifact: (request, artifactId, browsePath, viewer) =>
      Effect.gen(function* () {
        yield* migratedDb;
        const row = yield* Effect.promise(() => findArtifact(artifactDeps, artifactId));
        const visible =
          row !== null &&
          (yield* Effect.promise(() => artifactVisible(row, artifactReader(env.DB, viewer))));
        if (row === null || !visible)
          return yield* apiError("not_found", `no artifact ${artifactId}`);
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
    artifacts: (executionId, page, viewer) =>
      Effect.gen(function* () {
        yield* migratedDb;
        return yield* Effect.promise(() =>
          artifactPage(artifactDeps, executionId, page, artifactReader(env.DB, viewer)),
        );
      }),
  });
};

const response = <R>(effect: Effect.Effect<Response, ApiError, R>) =>
  Effect.map(effect, (r) => HttpServerResponse.fromWeb(r));

const sourceOf = (request: HttpServerRequest.HttpServerRequest) => request.source as Request;

/** The caller the router's gate identified, and whether the overlay lists it in `operators`. */
const currentViewer = Effect.gen(function* () {
  const identity = yield* CurrentIdentity;
  const config = yield* ApiConfig;
  const operator = Match.value(identity).pipe(
    Match.tag("Access", ({ id }) => inGroup(config, "operators", id)),
    Match.orElse(() => false),
  );
  return { identity, operator } satisfies ArtifactViewer;
});

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

/**
 * The artifacts group's handlers (FD-CACHE-075, FD-CACHE-076, FD-CACHE-078). The listing writes each artifact's URL
 * with a link token bound to that artifact, for the configured link lifetime (FD-CACHE-077).
 */
export const ArtifactsHandlers = HttpApiBuilder.group(FlareDispatchApi, "artifacts", (handlers) =>
  handlers
    .handle("get", ({ params, request }) =>
      response(
        Effect.gen(function* () {
          const viewer = yield* currentViewer;
          return yield* CacheReads.use((reads) =>
            reads.artifact(
              sourceOf(request),
              params.artifact_id,
              params["*"] === undefined || params["*"] === "" ? undefined : params["*"],
              viewer,
            ),
          );
        }),
      ),
    )
    .handle("list", ({ params, query }) =>
      Effect.gen(function* () {
        const viewer = yield* currentViewer;
        const page = yield* CacheReads.use((reads) =>
          reads.artifacts(
            params.id,
            { limit: query.limit ?? ARTIFACT_PAGE_SIZE, cursor: query.cursor ?? "" },
            viewer,
          ),
        );
        const artifacts = yield* Effect.forEach(page.artifacts, (entry) =>
          Effect.map(artifactUrl(entry.artifact_id, "listing"), (url) => ({ ...entry, url })),
        );
        return { artifacts, cursor: page.cursor };
      }),
    ),
);
