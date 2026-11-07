// The request id the router assigns to every request: every error body carries it (FD-IFC-009), a defect is recorded
// under it (FD-IFC-008), and every operator operation writes it on its audit row (FD-IFC-083).
import { Context } from "effect";
import { HttpApiMiddleware } from "effect/http-api";

export class RequestId extends Context.Service<RequestId, string>()(
  "@fractalboxdev/flare-dispatch-api/RequestId",
) {}

/**
 * Every group of the declaration carries this middleware. On the server it turns a handler's error, or a request that
 * fails its schema, into the error model's JSON response under the request id; clients need no part of it.
 */
export class ErrorModel extends HttpApiMiddleware.Service<ErrorModel, { requires: RequestId }>()(
  "@fractalboxdev/flare-dispatch-api/ErrorModel",
) {}
