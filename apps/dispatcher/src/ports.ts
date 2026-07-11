// FlareDispatch Dispatcher — request-scoped ports (Effect services + Layers).
//
// The HTTP surface is an `@effect/platform` `HttpRouter` (http-app.ts). Rather
// than thread the raw `Env` binding object through every route, the router
// depends on a small set of typed PORTS, each a `Context.Tag` with a `*Live`
// Layer that adapts the existing plain-function modules (executions-read.ts,
// log-token.ts, access-auth.ts) to an Effect interface:
//
//   * CurrentEnv      — the raw binding `Env`, provided per request. Legacy
//                       route handlers (dispatch/webhooks/artifacts/…) still
//                       take `Env` directly, so they read it back off this tag.
//   * Access          — the Cloudflare Access gate over viewer surfaces.
//   * ExecutionsRead  — the read-side D1 queries the dashboard renders.
//   * LogToken        — mints the per-execution capability URLs (`/logs`,
//                       `/demos`) the dashboard links to.
//
// Every Layer is built from `CurrentEnv`, which `handleRequest` supplies once
// per request (router.ts). The interfaces are synchronous to construct and hold
// no resources, so providing them per request is cheap — no ManagedRuntime
// teardown to worry about.

import { Context, Effect, Layer, Option } from "effect";

import { gateViewerAccess } from "./access-auth";
import type { Env } from "./env";
import {
  aggregateByRun,
  getExecution,
  getSteps,
  listExecutions,
  type ExecutionRow,
  type ListFilters,
  type RunAnalytics,
  type StepRow,
} from "./executions-read";
import {
  buildLogsUrl,
  resolveLogLinkSecret,
  signLogToken,
} from "./log-token";

// ---------------------------------------------------------------------------
// CurrentEnv — the raw binding environment, provided per request.
// ---------------------------------------------------------------------------

export class CurrentEnv extends Context.Tag("dispatcher/CurrentEnv")<
  CurrentEnv,
  Env
>() {}

// ---------------------------------------------------------------------------
// Access — Cloudflare Access enforcement for viewer surfaces.
// ---------------------------------------------------------------------------

export interface AccessService {
  /**
   * Gate a viewer surface. Resolves `Some(response)` with the 503/403 to return
   * as-is when the request is refused, or `None` when it may proceed (mode is
   * `token-only`, or a valid Access JWT was presented). Mirrors
   * `gateViewerAccess`, the `null`-means-proceed sentinel turned into `Option`.
   */
  readonly gate: (request: Request) => Effect.Effect<Option.Option<Response>>;
}

export class Access extends Context.Tag("dispatcher/Access")<
  Access,
  AccessService
>() {}

export const AccessLive = Layer.effect(
  Access,
  Effect.gen(function* () {
    const env = yield* CurrentEnv;
    return Access.of({
      gate: (request) =>
        Effect.promise(() => gateViewerAccess(env, request)).pipe(
          Effect.map(Option.fromNullable),
        ),
    });
  }),
);

// ---------------------------------------------------------------------------
// ExecutionsRead — read-side D1 queries.
// ---------------------------------------------------------------------------

export interface ExecutionsReadService {
  readonly list: (
    filters: ListFilters,
  ) => Effect.Effect<ReadonlyArray<ExecutionRow>>;
  readonly get: (id: string) => Effect.Effect<Option.Option<ExecutionRow>>;
  readonly steps: (id: string) => Effect.Effect<ReadonlyArray<StepRow>>;
  /** MEASURED per-recipe speed+cost aggregate over the last `limit` finished
   *  executions (the `/v1/analytics.json` feed). */
  readonly aggregate: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<RunAnalytics>>;
}

export class ExecutionsRead extends Context.Tag("dispatcher/ExecutionsRead")<
  ExecutionsRead,
  ExecutionsReadService
>() {}

export const ExecutionsReadLive = Layer.effect(
  ExecutionsRead,
  Effect.gen(function* () {
    const env = yield* CurrentEnv;
    const db = env.RUNS_METADATA;
    return ExecutionsRead.of({
      list: (filters) => Effect.promise(() => listExecutions(db, filters)),
      get: (id) =>
        Effect.promise(() => getExecution(db, id)).pipe(
          Effect.map(Option.fromNullable),
        ),
      steps: (id) => Effect.promise(() => getSteps(db, id)),
      aggregate: (limit) => Effect.promise(() => aggregateByRun(db, limit)),
    });
  }),
);

// ---------------------------------------------------------------------------
// LogToken — per-execution capability URLs for the viewer surfaces.
// ---------------------------------------------------------------------------

/** Strip a trailing slash from an origin (mirrors buildLogsUrl). */
const trimOrigin = (origin: string): string => origin.replace(/\/$/, "");

export interface LogTokenService {
  /**
   * The bare per-execution capability token, or `None` when no key material is
   * configured. For building tokened API URLs by hand (e.g. the per-log-file
   * links in the executions detail response).
   */
  readonly token: (executionId: string) => Effect.Effect<Option.Option<string>>;
  /** Tokened `/logs/:id?t=…` URL, or `None` when no key material is configured. */
  readonly logsUrl: (
    origin: string,
    executionId: string,
  ) => Effect.Effect<Option.Option<string>>;
  /** Tokened `/demos/:id?t=…` URL (same capability token as the log viewer). */
  readonly demosUrl: (
    origin: string,
    executionId: string,
  ) => Effect.Effect<Option.Option<string>>;
}

export class LogToken extends Context.Tag("dispatcher/LogToken")<
  LogToken,
  LogTokenService
>() {}

export const LogTokenLive = Layer.effect(
  LogToken,
  Effect.gen(function* () {
    const env = yield* CurrentEnv;
    const secret = resolveLogLinkSecret(env);
    const sign = (
      origin: string,
      executionId: string,
      build: (token: string) => string,
    ): Effect.Effect<Option.Option<string>> =>
      secret === undefined
        ? Effect.succeed(Option.none())
        : Effect.promise(() => signLogToken(secret, executionId)).pipe(
            Effect.map((token) => Option.some(build(token))),
          );
    return LogToken.of({
      token: (executionId) =>
        secret === undefined
          ? Effect.succeed(Option.none())
          : Effect.promise(() => signLogToken(secret, executionId)).pipe(
              Effect.map(Option.some),
            ),
      logsUrl: (origin, executionId) =>
        sign(origin, executionId, (token) =>
          buildLogsUrl(origin, executionId, token),
        ),
      demosUrl: (origin, executionId) =>
        sign(
          origin,
          executionId,
          (token) =>
            `${trimOrigin(origin)}/demos/${encodeURIComponent(
              executionId,
            )}?t=${token}`,
        ),
    });
  }),
);

// ---------------------------------------------------------------------------
// The composed request-scoped Layer.
// ---------------------------------------------------------------------------

/**
 * All request-scoped ports, fed by a `CurrentEnv` carrying this request's
 * bindings. `handleRequest` provides this once per request before handing the
 * router to `HttpApp.toWebHandler`.
 */
export const portsLayer = (env: Env) =>
  Layer.mergeAll(AccessLive, ExecutionsReadLive, LogTokenLive).pipe(
    Layer.provideMerge(Layer.succeed(CurrentEnv, env)),
  );
