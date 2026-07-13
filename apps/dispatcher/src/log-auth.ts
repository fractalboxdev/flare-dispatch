// FlareDispatch Dispatcher — the per-execution log-access HTTP gate.
//
// Shared by every per-execution log surface (routes/logs.ts, the per-id half of
// routes/executions.ts): validate the execution id, then require a valid
// capability token (apps/dispatcher/src/log-token.ts). Default-DENY when no key
// material is configured — the log surfaces are never silently open.

import type { Env } from "./env";
import {
  isValidExecutionId,
  resolveLogLinkSecret,
  verifyLogToken,
} from "./log-token";

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Gate access to a per-execution log surface. Returns `null` when the request
 * may proceed, or an error `Response` to return as-is:
 *
 *   400 invalid_execution_id — the id is malformed (never reaches R2/D1)
 *   503 logs_not_configured  — neither LOG_LINK_SECRET nor HMAC_SECRET set
 *   403 forbidden            — token missing or invalid for this execution
 *
 * The token is read from the `t` query param (works for links and the
 * WebSocket-less fetches the viewer makes; browsers cannot set headers on a
 * top-level navigation either).
 */
export const gateLogAccess = async (
  env: Env,
  executionId: string,
  url: URL,
): Promise<Response | null> => {
  if (!isValidExecutionId(executionId)) {
    return json(
      { error: "invalid_execution_id", message: "malformed execution id" },
      400,
    );
  }
  const secret = resolveLogLinkSecret(env);
  if (secret === undefined) {
    return json(
      {
        error: "logs_not_configured",
        message:
          "log viewing is off on this deploy (set LOG_LINK_SECRET, or HMAC_SECRET)",
      },
      503,
    );
  }
  const token = url.searchParams.get("t");
  if (!(await verifyLogToken(secret, executionId, token))) {
    return json(
      {
        error: "forbidden",
        message: "missing or invalid log token `t` for this execution",
      },
      403,
    );
  }
  return null;
};
