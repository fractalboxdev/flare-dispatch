// The v2 control plane Worker: mameko's coordinator on host-cloudflare, FlareDispatch's profile and the routes
// `pnpm dogfood` drives. It shares no code with the v1 dispatcher.
import { routeExecutorUpgrade, runD1Migrations } from "@fractalboxdev/mameko-host-cloudflare";
import { Cause, Effect } from "effect";
import { ApiError, dispatch, getExecution, register, requireOperator } from "./api.ts";
import { deployment, type ControlPlaneEnv } from "./config.ts";
import { EXECUTION_INPUTS_MIGRATION } from "./inputs.ts";

export {
  EpochAnchor,
  ExecutionEngine,
  ExecutorChannel,
  LivenessMonitor,
} from "./durable-objects.ts";

let migrated: Promise<unknown> | undefined;

const migrate = (env: ControlPlaneEnv) =>
  (migrated ??= (async () => {
    await runD1Migrations(env.DB);
    await env.DB.prepare(EXECUTION_INPUTS_MIGRATION).run();
  })());

const route = (request: Request, env: ControlPlaneEnv, url: URL) =>
  Effect.gen(function* () {
    const { pathname } = url;
    const method = request.method;
    if (pathname === "/health")
      return Response.json({ status: "ok", deployment: deployment(env), plane_id: env.PLANE_ID });
    yield* Effect.promise(() => migrate(env));
    // The route verifies the upgrade's connect signature, the one device credential (FD-IFC-085).
    if (pathname === "/v1/executors/connect")
      return yield* Effect.promise(() =>
        routeExecutorUpgrade(request, { db: env.DB, channel: env.CHANNEL, planeId: env.PLANE_ID }),
      );
    yield* requireOperator(request, env);
    if (pathname === "/v1/executors/register" && method === "POST")
      return yield* register(request, env);
    const dispatched = /^\/v1\/dispatch\/([^/]+)$/.exec(pathname)?.[1];
    if (dispatched !== undefined && method === "POST")
      return yield* dispatch(dispatched, request, env);
    const execution = /^\/v1\/executions\/([^/]+)$/.exec(pathname)?.[1];
    if (execution !== undefined && method === "GET")
      return yield* getExecution(execution, url, env);
    return yield* new ApiError({ status: 404, code: "not_found", message: "no such route" });
  });

const errorResponse = (error: ApiError, requestId: string) =>
  Response.json(
    { error: error.code, message: error.message, request_id: requestId },
    { status: error.status },
  );

export default {
  fetch(request: Request, env: ControlPlaneEnv): Promise<Response> {
    const requestId = crypto.randomUUID();
    return Effect.runPromise(
      route(request, env, new URL(request.url)).pipe(
        Effect.catchTag("ApiError", (error) => Effect.succeed(errorResponse(error, requestId))),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            console.error(`request ${requestId}: ${Cause.pretty(cause)}`);
            return errorResponse(
              new ApiError({ status: 500, code: "internal", message: "internal error" }),
              requestId,
            );
          }),
        ),
      ),
    );
  },
};
