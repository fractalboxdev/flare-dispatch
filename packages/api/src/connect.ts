// `/v1/executors/connect`: every device upgrade goes to mameko's executor route with the overlay's `executors.planeId`,
// which verifies the `connect` signature against the executor row's device key; no other device credential is
// accepted (FD-IFC-085). A `101` response carries a live WebSocket that no `HttpServerResponse` can hold, so the Worker
// calls this before the router.
import { routeExecutorUpgrade, type D1Like } from "@fractalboxdev/mameko-host-cloudflare";
import { apiError, errorBody } from "./errors.ts";

export const EXECUTOR_CONNECT_PATH = "/v1/executors/connect";

export interface ConnectOptions {
  readonly db: D1Like;
  readonly channel: Parameters<typeof routeExecutorUpgrade>[1]["channel"];
  /** `executors.planeId`; absent, the route answers `not_configured`. */
  readonly planeId: string | undefined;
}

export const isExecutorConnect = (request: Request): boolean =>
  new URL(request.url).pathname === EXECUTOR_CONNECT_PATH;

export const handleExecutorConnect = (
  request: Request,
  options: ConnectOptions,
): Promise<Response> => {
  if (options.planeId === undefined)
    return Promise.resolve(
      Response.json(
        errorBody(
          apiError("not_configured", "this deployment has no executors.planeId"),
          crypto.randomUUID(),
        ),
        { status: 503 },
      ),
    );
  return routeExecutorUpgrade(request, {
    db: options.db,
    channel: options.channel,
    planeId: options.planeId,
  });
};
