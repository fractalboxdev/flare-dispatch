// The dashboard's pages as one handler the Worker mounts before its router: the overview at `/` and one execution's
// page at `/executions/:id`, behind the Access gate. The router serves the `/v1/` routes, the operability ones through
// `OperabilityHandlers`. The operator routes of `operator-routes.ts` answer here when the composition supplies
// `OperatorOperations`; a composition without it leaves them to the router.
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Cause, Effect, Layer } from "effect";
import {
  deniedResponse,
  JwksCache,
  requireAccess,
  requireOperator,
  type AccessConfig,
} from "./access.ts";
import { opsConfigFrom, type OpsConfig } from "./config.ts";
import {
  executionDetail,
  fleet,
  listExecutions,
  overview,
  parseExecutionQuery,
  renderExecutionDetail,
  renderExecutions,
  renderFleet,
  renderOverview,
  renderPage,
} from "./dashboard.ts";
import { dashboardLogLink, linkConfigFrom } from "./link-token.ts";
import { runOpsMigrations } from "./liveness.ts";
import { matchOperatorRoute, operatorRoute, OperatorOperations } from "./operator-routes.ts";

/** What the pages compose beside the Worker's env. */
export interface OpsRouteDeps {
  /** The classes the overview lists, in rank order. */
  readonly classes: readonly string[];
  readonly operations?: Layer.Layer<OperatorOperations>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** The bindings the pages read: the D1 database and the runtime configuration's vars and secrets. */
export type OpsRouteEnv = { readonly DB: D1Like } & Readonly<Record<string, unknown>>;

/** One JWKS cache per fetch function and issuer for the isolate's lifetime, so requests share fetched keys. */
const jwksCaches = new WeakMap<typeof fetch, Map<string, JwksCache>>();

const jwksFor = (fetcher: typeof fetch, issuer: string): JwksCache => {
  let byIssuer = jwksCaches.get(fetcher);
  if (byIssuer === undefined) {
    byIssuer = new Map();
    jwksCaches.set(fetcher, byIssuer);
  }
  let cache = byIssuer.get(issuer);
  if (cache === undefined) {
    cache = new JwksCache(issuer, fetcher);
    byIssuer.set(issuer, cache);
  }
  return cache;
};

const accessConfig = (c: OpsConfig, deps: OpsRouteDeps): AccessConfig => ({
  teamDomain: c.ACCESS_TEAM_DOMAIN,
  aud: c.ACCESS_AUD,
  jwks: (issuer) => jwksFor(deps.fetch ?? fetch, issuer),
  ...(deps.now === undefined ? {} : { now: deps.now }),
});

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

const EXECUTION_PAGE = /^\/executions\/([^/]+)$/;

/** A path segment decoded, or null when its percent-encoding is malformed. */
const decodeSegment = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

const route = (request: Request, env: OpsRouteEnv, deps: OpsRouteDeps, requestId: string) =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    const { pathname } = url;
    const now = (deps.now ?? Date.now)();
    const operatorMatch = deps.operations === undefined ? null : matchOperatorRoute(pathname);
    if (operatorMatch === null && pathname !== "/" && !EXECUTION_PAGE.test(pathname)) return null;
    const config = yield* opsConfigFrom(env);
    const access = accessConfig(config, deps);
    if (operatorMatch !== null && deps.operations !== undefined) {
      const operator = yield* requireOperator(request, access, config.OPERATORS ?? []);
      return yield* operatorRoute(request, operatorMatch, operator.name, requestId, now).pipe(
        Effect.provide(deps.operations),
      );
    }
    yield* requireAccess(request, access);
    yield* Effect.promise(() => runOpsMigrations(env.DB));
    const linkConfig = yield* linkConfigFrom(env, url.origin);
    const linkFor = (id: string) => dashboardLogLink(linkConfig, id, Math.floor(now / 1000));
    const executionPage = EXECUTION_PAGE.exec(pathname);
    if (executionPage !== null) {
      const id = decodeSegment(executionPage[1] as string);
      const detail = id === null ? null : yield* Effect.promise(() => executionDetail(env.DB, id));
      if (detail === null)
        return html(renderPage(["<h2>Execution</h2><p>No execution has this id.</p>"]), 404);
      return html(renderPage([renderExecutionDetail(detail, yield* linkFor(detail.execution.id))]));
    }
    const { filters, limit, cursor } = parseExecutionQuery(url);
    const page = yield* Effect.promise(() => listExecutions(env.DB, filters, limit, cursor));
    const links: Record<string, string> = {};
    for (const r of page.rows) {
      const link = yield* linkFor(r.id);
      if (link !== null) links[r.id] = link;
    }
    const [o, f] = yield* Effect.promise(() =>
      Promise.all([overview(env.DB, deps.classes, now), fleet(env.DB, now)]),
    );
    return html(
      renderPage([renderOverview(o), renderExecutions(page, filters, links), renderFleet(f)]),
    );
  });

/**
 * Serves a dashboard page, or an operator route when the composition supplies its operations, or answers null:
 * `const ops = await opsFetch(request, env, deps); if (ops !== null) return ops;`.
 */
export const opsFetch = (
  request: Request,
  env: OpsRouteEnv,
  deps: OpsRouteDeps,
): Promise<Response | null> => {
  const requestId = crypto.randomUUID();
  return Effect.runPromise(
    route(request, env, deps, requestId).pipe(
      Effect.catchTags({
        AccessDenied: (denied) => Effect.succeed(deniedResponse(denied, requestId)),
        ConfigInvalid: (e) =>
          Effect.succeed(
            Response.json(
              { error: "misconfigured", message: e.issues.join("; "), request_id: requestId },
              { status: 503 },
            ),
          ),
      }),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          console.error(`request ${requestId}: ${Cause.pretty(cause)}`);
          return Response.json(
            { error: "internal", message: "internal error", request_id: requestId },
            { status: 500 },
          );
        }),
      ),
    ),
  );
};
