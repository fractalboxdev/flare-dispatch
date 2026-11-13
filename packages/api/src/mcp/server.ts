// The dispatcher's MCP server at `/mcp` (FD-IFC-072): `dispatch`, `get_verdict`, `get_failure_summary` and `cancel` over
// Streamable HTTP. The router's gate answers 401 to a request without a valid Access JWT before the server sees it
// (FD-IFC-073), and each tool runs the route logic it wraps under the request's identity and services, so `dispatch`
// keeps the identity, dedup, class and catalog rules of `POST /v1/dispatch/:run` (FD-IFC-074).
//
// TODO(maintainer): the per-request transport serves only the sessionless revision 2026-07-28, and a sessionful
// revision needs its sessions held in a Durable Object rather than one isolate's memory; decide which clients `/mcp`
// serves (specs/interfaces.md § Open items, FD-IFC-072).
import { Effect, Layer, Match } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import type { ApiError } from "../errors.ts";
import { CurrentIdentity, inGroup, type AccessIdentity } from "../identity.ts";
import { ApiConfig } from "../config.ts";
import { routerGroup, type Surface } from "../router.ts";
import { authorizeDispatch, submissionOf, submit } from "../routes/dispatch.ts";
import { awaitExecution, cancelExecution, failureSummary, viewOf } from "../routes/executions.ts";
import {
  boundResult,
  checkWait,
  DispatcherTools,
  MAX_WAIT_S,
  toToolError,
  type ToolError,
} from "./tools.ts";

export const MCP_PATH = "/mcp";

/**
 * Tool handlers run inside the request that carried the call, so they read the router's per-request services (the
 * identity, the request id, the configuration and the ports) from the request's context, which takes precedence over
 * the context the toolkit Layer captured. The toolkit declares no dependencies for them, so the type says so here.
 */
const inRequest = <A, R>(
  effect: Effect.Effect<A, ApiError | ToolError, R>,
): Effect.Effect<A, ToolError> =>
  (effect as Effect.Effect<A, ApiError | ToolError>).pipe(
    Effect.mapError((e) => ("_tag" in e ? toToolError(e) : e)),
  );

/** The caller of `dispatch`: an Access identity in `dispatchers`, as `POST /v1/dispatch/:run` requires (FD-IFC-027). */
const dispatcher = Effect.gen(function* () {
  const identity = yield* CurrentIdentity;
  const config = yield* ApiConfig;
  return yield* Match.value(identity).pipe(
    Match.tag("Access", (access) =>
      inGroup(config, "dispatchers", access.id)
        ? Effect.succeed<AccessIdentity>(access)
        : Effect.fail<ToolError>({
            error: "unauthenticated",
            message: "dispatch needs the Access identity of a dispatcher",
          }),
    ),
    Match.orElse(() =>
      Effect.fail<ToolError>({
        error: "unauthenticated",
        message: "dispatch needs an Access identity",
      }),
    ),
  );
});

export const DispatcherToolsLive = DispatcherTools.toLayer({
  dispatch: (params) =>
    inRequest(
      Effect.gen(function* () {
        const wait = yield* checkWait(params.wait_seconds, MAX_WAIT_S);
        const identity = yield* dispatcher;
        const classCeiling = yield* authorizeDispatch(identity, params.run, params.repo);
        const submission = yield* submissionOf(
          identity,
          params.run,
          {
            repository: params.repo,
            inputs: params.inputs,
            ...(params.ref === undefined ? {} : { ref: params.ref }),
            ...(params.sha === undefined ? {} : { sha: params.sha }),
            ...(params.class === undefined ? {} : { class: params.class }),
          },
          undefined,
          "mcp",
          classCeiling,
        );
        const dispatched = yield* submit(submission);
        if (wait === 0) return yield* boundResult(dispatched);
        const verdict = viewOf(yield* awaitExecution(dispatched.execution_id, wait));
        return yield* boundResult({ ...dispatched, verdict });
      }),
    ),
  get_verdict: (params) =>
    inRequest(
      Effect.gen(function* () {
        const wait = yield* checkWait(params.wait_seconds, MAX_WAIT_S);
        return yield* boundResult(viewOf(yield* awaitExecution(params.execution_id, wait)));
      }),
    ),
  get_failure_summary: (params) =>
    inRequest(Effect.flatMap(failureSummary(params.execution_id), boundResult)),
  cancel: (params) => inRequest(Effect.flatMap(cancelExecution(params.execution_id), boundResult)),
});

/** `/mcp` takes an Access JWT, and a token that fails answers 401 like a missing one (FD-IFC-073). */
export const MCP_SURFACE: Surface = { _tag: "Access", group: "any", onInvalid: "unauthenticated" };

/** The `/mcp` route group, on the per-request transport a Worker needs. */
export const mcpGroup = routerGroup(
  "mcp",
  [{ method: "POST", path: MCP_PATH, surface: MCP_SURFACE }],
  McpServer.toolkit(DispatcherTools).pipe(
    Layer.provideMerge(
      McpServer.layerHttpRequestScoped({
        name: "flare-dispatch",
        version: "2",
        path: MCP_PATH,
        protocols: [McpProtocol.v2026_07_28],
      }),
    ),
    Layer.provide(DispatcherToolsLive),
    Layer.orDie,
  ) as never,
);
