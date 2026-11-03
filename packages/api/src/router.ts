// The dispatcher's router: route groups mounted onto one `HttpRouter`, behind one gate that runs before any route.
//
// For every request the gate assigns a request id, finds the surface the path belongs to, runs that surface's identity
// check (FD-IFC-003, FD-IFC-010), then answers 404 `not_found` for an unknown path (FD-IFC-004), 405
// `method_not_allowed` for a known path with another method (FD-IFC-005) and 413 `payload_too_large` for a body over
// the route's limit without parsing it (FD-IFC-006). Only then does the route run. Every error leaves as the error
// model's JSON (FD-IFC-009); a defect is logged under the request id and answers 500 `internal` (FD-IFC-008).
import { Cause, Context, Effect, Layer, Match, Option } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  type HttpApiEndpoint,
  HttpApiError,
  type HttpApiGroup,
} from "effect/http-api";
import { SchemaIssue } from "effect";
import { ApiConfig } from "./config.ts";
import { apiError, errorBody, isApiError, statusOfError, type ApiError } from "./errors.ts";
import {
  authenticateAccess,
  authenticateActions,
  authenticateDispatch,
  authenticateLink,
  CurrentIdentity,
  inGroup,
  readBearer,
  type AccessGroup,
  type Identity,
  type LoginRedirect,
} from "./identity.ts";
import { JwksSource } from "./jwt.ts";
import type { LinkPurpose } from "./link-token.ts";
import { ErrorModel, RequestId } from "./request-id.ts";

/** The default body limit of a route: 1 MiB (FD-IFC-006). */
export const DEFAULT_BODY_LIMIT = 1_048_576;

/** The identity check a route's surface passes (specs/interfaces.md § Surfaces and their identity gates). */
export type Surface =
  /** A valid Access JWT; `group` narrows it to `operators` or `dispatchers`. */
  | {
      readonly _tag: "Access";
      readonly group: AccessGroup;
      /** A browser with no identity is redirected to the Access login instead of answered 401. */
      readonly redirectBrowser?: boolean;
      /** The code a token that fails verification answers: `forbidden` (FD-IFC-012) unless the surface says so. */
      readonly onInvalid?: "forbidden" | "unauthenticated";
    }
  /** An Actions OIDC token, or the Access JWT of a dispatcher (FD-IFC-027). */
  | { readonly _tag: "Dispatch" }
  /**
   * An Access JWT, or an Actions OIDC token as the bearer: the execution a dispatch action waits on (FD-IFC-059). The
   * route answers an Actions identity only for its own repository.
   */
  | { readonly _tag: "AccessOrActions" }
  /** An Access JWT, or a link token for the object the path parameter `param` names (FD-IFC-017). */
  | { readonly _tag: "Link"; readonly purpose: LinkPurpose; readonly param: string }
  /** The route verifies its own credential: a webhook HMAC, a connect signature, a cache or per-lease token. */
  | { readonly _tag: "OwnCredential" }
  /** `/health` and `/.well-known/*`. */
  | { readonly _tag: "Public" };

export type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "PROPFIND" | "MKCOL";

export interface RouteSpec {
  readonly method: Method;
  /** A path with `:param` segments and an optional trailing `*`, as `HttpRouter` takes it. */
  readonly path: `/${string}`;
  readonly surface: Surface;
  /** The body limit in bytes; `DEFAULT_BODY_LIMIT` when absent. */
  readonly maxBodyBytes?: number;
}

/**
 * One mountable unit: the routes it serves, each with its surface, and the Layer that registers them on the router.
 * `R` is what its handlers read per request.
 */
export interface RouteGroup<R = never> {
  readonly name: string;
  readonly routes: readonly RouteSpec[];
  readonly layer: Layer.Layer<
    never,
    never,
    HttpRouter.HttpRouter | HttpRouter.Request<"Requires", R>
  >;
}

/** The mounted groups. `R` is the union of what their handlers read per request. */
export interface DispatcherRouter<R = never> {
  readonly groups: readonly RouteGroup<R>[];
  readonly routes: readonly RouteSpec[];
}

// --- Path matching ---------------------------------------------------------------------------------------------------

interface Match_ {
  readonly route: RouteSpec;
  readonly params: Readonly<Record<string, string>>;
  /** Static segments count most, then parameters; a wildcard least. */
  readonly score: number;
}

const segmentsOf = (path: string) => path.split("/").filter((s) => s.length > 0);

const matchRoute = (route: RouteSpec, segments: readonly string[]): Match_ | undefined => {
  const pattern = segmentsOf(route.path);
  const params: Record<string, string> = {};
  let score = 0;
  for (let i = 0; i < pattern.length; i++) {
    const part = pattern[i]!;
    if (part === "*" && i === pattern.length - 1) return { route, params, score };
    const segment = segments[i];
    if (segment === undefined) return undefined;
    if (part.startsWith(":")) {
      try {
        params[part.slice(1)] = decodeURIComponent(segment);
      } catch {
        return undefined;
      }
      score += 2;
    } else if (part === segment) score += 3;
    else return undefined;
  }
  return pattern.length === segments.length ? { route, params, score } : undefined;
};

/** The routes whose path matches, most specific first. */
export const matchPath = (routes: readonly RouteSpec[], pathname: string): readonly Match_[] => {
  const segments = segmentsOf(pathname);
  return routes
    .flatMap((route) => {
      const m = matchRoute(route, segments);
      return m === undefined ? [] : [m];
    })
    .sort((a, b) => b.score - a.score);
};

// --- Responses -------------------------------------------------------------------------------------------------------

export const errorResponse = (
  error: ApiError,
  requestId: string,
): HttpServerResponse.HttpServerResponse => {
  const headers: Record<string, string> = {};
  if ("retry_after" in error && error.retry_after !== undefined)
    headers["retry-after"] = String(Math.max(0, Math.ceil(error.retry_after)));
  return HttpServerResponse.jsonUnsafe(errorBody(error, requestId), {
    status: statusOfError(error),
    headers,
  });
};

const pathText = (path: ReadonlyArray<PropertyKey>) =>
  path.length === 0 ? "the body" : path.map((p) => String(p)).join(".");

const standardFormatter = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * A request that fails its schema answers 400 naming the first failing path (FD-IFC-007): `invalid_signals` when the
 * path is under `signals` (FD-IFC-030), `invalid_body` otherwise.
 */
export const schemaErrorResponse = (
  error: HttpApiError.HttpApiSchemaError,
  requestId: string,
): HttpServerResponse.HttpServerResponse => {
  const first = standardFormatter(error.cause.issue).issues[0];
  const path = (first?.path ?? []).map((p) =>
    typeof p === "object" && p !== null && "key" in p ? (p as { key: PropertyKey }).key : p,
  ) as PropertyKey[];
  const where =
    error.kind === "Payload" || error.kind === "Body" ? path : [error.kind.toLowerCase(), ...path];
  const code = where[0] === "signals" ? "invalid_signals" : "invalid_body";
  return errorResponse(
    apiError(code, `${pathText(where)}: ${first?.message ?? "does not match the schema"}`),
    requestId,
  );
};

/** The server half of `ErrorModel`: handler errors and schema failures become error-model responses. */
export const ErrorModelLive = Layer.succeed(ErrorModel)(
  (httpEffect) =>
    Effect.gen(function* () {
      const requestId = yield* RequestId;
      return yield* (
        httpEffect as Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>
      ).pipe(
        Effect.catch((error) =>
          isApiError(error)
            ? Effect.succeed(errorResponse(error, requestId))
            : HttpApiError.HttpApiSchemaError.is(error)
              ? Effect.succeed(schemaErrorResponse(error, requestId))
              : Effect.fail(error),
        ),
      );
    }) as never,
);

// --- The gate --------------------------------------------------------------------------------------------------------

const redirectResponse = (redirect: LoginRedirect) =>
  HttpServerResponse.empty({ status: 302, headers: { location: redirect.location } });

type GateOutcome = Identity | LoginRedirect;

const accessCheck = (
  request: Request,
  surface: Extract<Surface, { readonly _tag: "Access" }>,
): Effect.Effect<GateOutcome, ApiError, ApiConfig | JwksSource> =>
  Effect.gen(function* () {
    const outcome = yield* authenticateAccess(request, {
      redirectBrowser: surface.redirectBrowser === true,
    }).pipe(
      Effect.catch((error) =>
        Effect.fail(
          surface.onInvalid === "unauthenticated" && error.error === "forbidden"
            ? apiError("unauthenticated", error.message)
            : error,
        ),
      ),
    );
    if (outcome._tag === "LoginRedirect" || surface.group === "any") return outcome;
    const config = yield* ApiConfig;
    if (!inGroup(config, surface.group, outcome.id))
      return yield* apiError("forbidden", `the identity is not in ${surface.group}`);
    return outcome;
  });

const surfaceCheck = (
  request: Request,
  surface: Surface,
  params: Readonly<Record<string, string>>,
): Effect.Effect<GateOutcome, ApiError, ApiConfig | JwksSource> =>
  Match.value(surface).pipe(
    Match.tagsExhaustive({
      Access: (s) => accessCheck(request, s),
      Dispatch: () => authenticateDispatch(request),
      AccessOrActions: () => {
        const bearer = readBearer(request);
        return bearer === undefined
          ? accessCheck(request, { _tag: "Access", group: "any" })
          : authenticateActions(bearer);
      },
      Link: (s) => authenticateLink(request, s.purpose, params[s.param] ?? ""),
      OwnCredential: () => Effect.succeed<Identity>({ _tag: "Unidentified" }),
      Public: () => Effect.succeed<Identity>({ _tag: "Unidentified" }),
    }),
  );

/** Every path under `/v1/` that no route claims still passes the Access gate before its 404 (FD-IFC-010). */
const UNCLAIMED_V1: Surface = { _tag: "Access", group: "any" };

/** Reads at most `limit + 1` bytes of a body with no `Content-Length`, so an oversized one is never buffered whole. */
const boundedBody = async (request: Request, limit: number): Promise<Uint8Array | "too-large"> => {
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return "too-large";
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

const BODYLESS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

const gate = (routes: readonly RouteSpec[]) =>
  HttpRouter.middleware<{ provides: RequestId | CurrentIdentity }>()(
    (inner) =>
      Effect.gen(function* () {
        const serverRequest = yield* HttpServerRequest.HttpServerRequest;
        const request = serverRequest.source as Request;
        const requestId = crypto.randomUUID();
        const respond = (error: ApiError) => Effect.succeed(errorResponse(error, requestId));
        const run = Effect.gen(function* () {
          const url = new URL(request.url);
          const matches = matchPath(routes, url.pathname);
          const surface =
            matches[0]?.route.surface ??
            (url.pathname.startsWith("/v1/") || url.pathname === "/v1" ? UNCLAIMED_V1 : undefined);
          const outcome =
            surface === undefined
              ? ({ _tag: "Unidentified" } as const)
              : yield* surfaceCheck(request, surface, matches[0]?.params ?? {});
          if (outcome._tag === "LoginRedirect") return redirectResponse(outcome);
          if (matches.length === 0) return yield* apiError("not_found", "no such route");
          const method = request.method.toUpperCase();
          const route = matches.find(
            (m) => m.route.method === method || (method === "HEAD" && m.route.method === "GET"),
          )?.route;
          if (route === undefined)
            return yield* apiError("method_not_allowed", `${method} is not served on this path`);
          const limit = route.maxBodyBytes ?? DEFAULT_BODY_LIMIT;
          let next = inner;
          if (!BODYLESS.has(method)) {
            const declared = request.headers.get("content-length");
            if (declared !== null && Number(declared) > limit)
              return yield* apiError("payload_too_large", `the body exceeds ${limit} bytes`);
            if (declared === null && request.body !== null) {
              const body = yield* Effect.promise(() => boundedBody(request, limit));
              if (body === "too-large")
                return yield* apiError("payload_too_large", `the body exceeds ${limit} bytes`);
              const replaced = new Request(request.url, {
                method: request.method,
                headers: request.headers,
                body: body as Uint8Array<ArrayBuffer>,
              });
              next = Effect.provideService(
                inner,
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(replaced),
              );
            }
          }
          return yield* next.pipe(Effect.provideService(CurrentIdentity, outcome));
        });
        return yield* run.pipe(
          Effect.provideService(RequestId, requestId),
          Effect.catchCause((cause) => {
            const failure = Cause.findErrorOption(cause);
            if (Option.isSome(failure)) {
              const error = failure.value;
              if (isApiError(error)) return respond(error);
              if (HttpApiError.HttpApiSchemaError.is(error))
                return Effect.succeed(schemaErrorResponse(error, requestId));
              if (HttpServerError.isHttpServerError(error) && error.reason._tag === "RouteNotFound")
                return respond(apiError("not_found", "no such route"));
              if (
                HttpServerError.isHttpServerError(error) &&
                error.reason._tag === "RequestParseError"
              )
                return respond(apiError("invalid_body", "the body is not valid JSON"));
            }
            const schemaDefect = cause.reasons.find(
              (r) => Cause.isDieReason(r) && HttpApiError.HttpApiSchemaError.is(r.defect),
            );
            if (schemaDefect !== undefined && Cause.isDieReason(schemaDefect))
              return Effect.succeed(
                schemaErrorResponse(
                  schemaDefect.defect as HttpApiError.HttpApiSchemaError,
                  requestId,
                ),
              );
            return Effect.sync(() => {
              console.error(`request ${requestId}: ${Cause.pretty(cause)}`);
              return errorResponse(apiError("internal", "internal error"), requestId);
            });
          }),
        );
      }) as never,
    { global: true },
  );

// --- Groups and mounting ---------------------------------------------------------------------------------------------

/** The per-request services a handler Layer's requirements name. */
type RequestServices<R> = R extends HttpRouter.Request<"Requires", infer S> ? S : never;

/**
 * A group of the declaration as a mountable unit: its endpoints, the surface of each, and the Layer implementing them.
 * The surfaces are keyed by endpoint name, so a declared endpoint cannot be mounted without one.
 */
export const apiGroup = <Group extends HttpApiGroup.Constraint, R>(options: {
  readonly group: Group;
  readonly surfaces: {
    readonly [K in HttpApiEndpoint.Identifier<HttpApiGroup.Endpoints<Group>>]: Surface;
  };
  readonly handlers: Layer.Layer<
    HttpApiGroup.Service<"flare-dispatch", Group["identifier"]>,
    never,
    R
  >;
  readonly maxBodyBytes?: Readonly<Record<string, number>>;
}): RouteGroup<RequestServices<R>> => {
  const endpoints = Object.values(options.group.endpoints) as unknown as ReadonlyArray<{
    readonly identifier: string;
    readonly method: Method;
    readonly path: `/${string}`;
  }>;
  const routes = endpoints.map((e) => ({
    method: e.method,
    path: e.path,
    surface: (options.surfaces as Readonly<Record<string, Surface>>)[e.identifier]!,
    ...(options.maxBodyBytes?.[e.identifier] === undefined
      ? {}
      : { maxBodyBytes: options.maxBodyBytes[e.identifier] }),
  }));
  const sub = HttpApi.make("flare-dispatch").add(options.group as never);
  const layer = HttpApiBuilder.layer(sub).pipe(
    Layer.provide(options.handlers as unknown as Layer.Layer<never>),
    Layer.provide(ErrorModelLive),
    Layer.provide(HttpServer.layerServices),
  );
  return { name: options.group.identifier, routes, layer: layer as never };
};

/** A unit of plain `HttpRouter` routes, for a route the declaration cannot model, such as a raw-body webhook. */
export const routerGroup = <R>(
  name: string,
  routes: readonly RouteSpec[],
  layer: Layer.Layer<never, never, HttpRouter.HttpRouter | HttpRouter.Request<"Requires", R>>,
): RouteGroup<R> => ({ name, routes, layer });

export class DuplicateRoute extends Error {}

/**
 * Mounts route groups into one router. Order does not change matching, which prefers the most specific path; a method
 * and path that two groups both claim is a configuration error and throws at mount.
 */
export const mount = <const Groups extends readonly RouteGroup<any>[]>(
  ...groups: Groups
): DispatcherRouter<Groups[number] extends RouteGroup<infer R> ? R : never> => {
  const seen = new Map<string, string>();
  for (const group of groups)
    for (const route of group.routes) {
      const key = `${route.method} ${route.path}`;
      const owner = seen.get(key);
      if (owner !== undefined)
        throw new DuplicateRoute(`${key} is claimed by both ${owner} and ${group.name}`);
      seen.set(key, group.name);
    }
  return { groups, routes: groups.flatMap((g) => g.routes) } as never;
};

/** The Layer of a mounted router: every group's routes behind the gate. */
export const routerLayer = <R>(router: DispatcherRouter<R>) =>
  Layer.mergeAll(
    gate(router.routes) as Layer.Layer<never, never, HttpRouter.HttpRouter>,
    ...router.groups.map((g) => g.layer),
  );

export type PerRequest<R> = (request: Request) => Context.Context<R | ApiConfig>;

/**
 * The Worker's `fetch`: build once at module scope, then call per request with that request's services. `shared` is
 * built once with the handler (the JWKS cache among them).
 */
export const toFetchHandler = <R>(
  router: DispatcherRouter<R>,
  options: { readonly shared?: Layer.Layer<JwksSource> } = {},
) => {
  const app = routerLayer(router).pipe(
    Layer.provideMerge(options.shared ?? (Layer.empty as never)),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(app as never, { disableLogger: true });
  return {
    fetch: (
      request: Request,
      services: Context.Context<R | ApiConfig | JwksSource>,
    ): Promise<Response> =>
      (handler as (r: Request, c: Context.Context<never>) => Promise<Response>)(
        request,
        services as Context.Context<never>,
      ),
    dispose,
  };
};
