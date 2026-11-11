// The operability routes as one handler the Worker mounts before its own: the dashboard, the execution page and the
// executions JSON route behind the Access gate, `/v1/ops/*` (the phase gate's records among them) and the install
// routes behind the operator gate, and `GET /v1/spend`. A route whose port the composition does not supply is not
// served, so it answers as an unknown route.
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
import { installCallback, ManifestConversion, startInstall } from "./install.ts";
import { dashboardLink } from "./link-token.ts";
import { livenessReport, runOpsMigrations } from "./liveness.ts";
import { matchOperatorRoute, operatorRoute, OperatorOperations } from "./operator-routes.ts";
import { spendRoute, SpendView } from "./spend.ts";
import { phaseGateRoute } from "./verification/records.ts";

/** What the routes compose beside the Worker's env. */
export interface OpsRouteDeps {
  /** The classes the overview lists, in rank order. */
  readonly classes: readonly string[];
  readonly operations?: Layer.Layer<OperatorOperations>;
  readonly spend?: Layer.Layer<SpendView>;
  readonly manifestConversion?: Layer.Layer<ManifestConversion>;
  /** The current link revocation epoch (FD-IFC-021). */
  readonly linkEpoch?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** The bindings the routes read: the D1 database and the runtime configuration's vars and secrets. */
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
    const served =
      pathname === "/" ||
      pathname === "/v1/executions" ||
      EXECUTION_PAGE.test(pathname) ||
      pathname === "/v1/spend" ||
      pathname.startsWith("/v1/ops/") ||
      pathname.startsWith("/v1/github/install/") ||
      /^\/v1\/executions\/[^/]+\/cancel$/.test(pathname);
    if (!served) return null;
    const config = yield* opsConfigFrom(env);
    const access = accessConfig(config, deps);
    const operators = config.OPERATORS ?? [];
    yield* Effect.promise(() => runOpsMigrations(env.DB));

    const operatorMatch = matchOperatorRoute(pathname);
    if (operatorMatch !== null) {
      if (deps.operations === undefined) return null;
      const operator = yield* requireOperator(request, access, operators);
      return yield* operatorRoute(request, operatorMatch, operator.name, requestId, now).pipe(
        Effect.provide(deps.operations),
      );
    }
    if (pathname === "/v1/ops/health") {
      yield* requireOperator(request, access, operators);
      return Response.json(yield* Effect.promise(() => livenessReport(env.DB, now)));
    }
    if (pathname === "/v1/ops/phase-gate") {
      yield* requireOperator(request, access, operators);
      return yield* phaseGateRoute(request, url, env.DB, now, requestId);
    }
    if (pathname === "/v1/ops/fleet") {
      yield* requireOperator(request, access, operators);
      return Response.json(yield* Effect.promise(() => fleet(env.DB, now)));
    }
    if (pathname === "/v1/github/install/new") {
      const operator = yield* requireOperator(request, access, operators);
      return yield* Effect.promise(() => startInstall(env.DB, operator, url.origin, now));
    }
    if (pathname === "/v1/github/install/callback") {
      if (deps.manifestConversion === undefined) return null;
      const operator = yield* requireOperator(request, access, operators);
      return yield* installCallback(env.DB, url, operator, now, requestId).pipe(
        Effect.provide(deps.manifestConversion),
      );
    }
    if (pathname === "/v1/spend") {
      if (deps.spend === undefined) return null;
      yield* requireAccess(request, access);
      return yield* spendRoute(now, requestId).pipe(Effect.provide(deps.spend));
    }
    if (pathname.startsWith("/v1/ops/")) return null;
    yield* requireAccess(request, access);
    const linkKey = config.LINK_KEY;
    const linkFor = (id: string) =>
      linkKey === undefined
        ? Effect.succeed(null)
        : Effect.promise(() =>
            dashboardLink({
              linkKey,
              purpose: "log",
              id,
              path: `/v1/executions/${encodeURIComponent(id)}/logs/run.log`,
              nowSeconds: Math.floor(now / 1000),
              epoch: deps.linkEpoch ?? 0,
            }),
          );
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
    if (pathname === "/v1/executions") return Response.json(page);
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
 * Serves an operability route, or answers null for a path it does not serve. Mount it first in the Worker's `fetch`:
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
