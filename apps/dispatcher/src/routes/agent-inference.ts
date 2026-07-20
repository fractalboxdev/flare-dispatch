// FlareDispatch Dispatcher — the self-heal model-proxy.
//
//   POST /v1/agent/:execution/inference
//
// An in-sandbox coding agent reaches a model through this route WITHOUT holding
// a model key: the Worker holds the AI binding and brokers the call (the same
// shape the log-viewer token gates container→Worker; NOT the static-token CDP
// bridge). Auth is a per-execution capability token (`agent-token.ts`); the hard
// token budget + request cap + liveness live in the AgentBudget DO
// (`agent-budget-do.ts`) — a stateless token can't hold them (security #1).
//
// The MODEL is resolved server-side (CONFIG_KV `self-heal.proxy.model` → env
// `AGENT_PROXY_MODEL` → a Workers AI default), never caller-chosen — an agent
// can't escalate to an arbitrary/expensive backend, and per-call output is
// clamped. Reserve(estimate) → modelGateway.complete → settle(actual): the
// reservation makes the cap hold even under concurrent calls.
//
// Spec: specs/08-self-healing.md § 6.3.

import { Effect, Schema } from "effect";
import { modelGateway, type ModelCompletionRequest } from "@fractalboxdev/flare-dispatch-core";
// Import from the lean subpath (NOT the package index) so the route's module
// graph doesn't pull @cloudflare/sandbox — keeps it loadable under plain-node
// vitest and out of the non-sandbox bundle. Mirrors @fractalboxdev/flare-dispatch-core/signals.
import { makeModelGatewayLive } from "@fractalboxdev/flare-dispatch-runtime-cf/model-gateway";
import type { Env } from "../env";
import {
  callerAgentToken,
  resolveAgentProxySecret,
  verifyAgentToken,
} from "../agent-token";
import { isValidExecutionId } from "../log-token";

/** Hard ceiling on a single call's output, regardless of what the agent asks. */
const MAX_OUTPUT_TOKENS_PER_CALL = 8192;
const OUTPUT_TOKENS_DEFAULT = 2048;
const PROXY_MODEL_DEFAULT = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const Tool = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  parameters: Schema.optional(Schema.Unknown),
});

/** The body the agent POSTs — it cannot pick the model (resolved server-side). */
const InferenceBody = Schema.Struct({
  system: Schema.String.pipe(Schema.maxLength(100_000)),
  user: Schema.String.pipe(Schema.maxLength(400_000)),
  tools: Schema.optional(Schema.Array(Tool)),
  maxTokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
});

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const log = (event: string, fields: Record<string, unknown>): void => {
  console.log(JSON.stringify({ event, ...fields }));
};

/** ~4 chars/token rough input estimate (only used to size the reservation). */
const estimateTokens = (system: string, user: string, maxOut: number): number =>
  Math.ceil((system.length + user.length) / 4) + maxOut;

export const handleAgentInference = async (
  request: Request,
  env: Env,
  executionId: string,
  requestId: string,
): Promise<Response> => {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  if (!isValidExecutionId(executionId)) {
    return json({ error: "invalid_execution_id" }, 400);
  }

  // Fail closed: no AI binding or no token key material ⇒ 503.
  if (env.AI === undefined) {
    log("agent.no_ai_binding", { request_id: requestId });
    return json({ error: "model binding not configured" }, 503);
  }
  if (env.AGENT_BUDGET === undefined) {
    log("agent.no_budget_do", { request_id: requestId });
    return json({ error: "agent budget not configured" }, 503);
  }
  const secret = resolveAgentProxySecret(env);
  if (secret === undefined) {
    log("agent.no_secret", { request_id: requestId });
    return json({ error: "agent proxy auth not configured" }, 503);
  }

  // Authenticate the per-execution capability token.
  const url = new URL(request.url);
  const presented = callerAgentToken(request, url);
  if (!(await verifyAgentToken(secret, executionId, presented))) {
    log("agent.unauthorized", { request_id: requestId, execution: executionId });
    return json({ error: "unauthorized" }, 401);
  }

  // Parse + validate the body.
  let parsed: typeof InferenceBody.Type;
  try {
    parsed = Schema.decodeUnknownSync(InferenceBody)(await request.json());
  } catch (e) {
    return json({ error: "invalid_body", detail: String(e).slice(0, 500) }, 400);
  }

  const maxOut = Math.min(
    MAX_OUTPUT_TOKENS_PER_CALL,
    Math.max(1, Math.floor(parsed.maxTokens ?? OUTPUT_TOKENS_DEFAULT)),
  );

  // Server-resolved model (never caller-chosen).
  const configModel = await env.CONFIG_KV?.get("self-heal.proxy.model");
  const model =
    (configModel !== null && configModel !== undefined && configModel.length > 0
      ? configModel
      : undefined) ??
    env.AGENT_PROXY_MODEL ??
    PROXY_MODEL_DEFAULT;

  // Reserve against the strongly-consistent budget DO BEFORE spending.
  const budget = env.AGENT_BUDGET.get(env.AGENT_BUDGET.idFromName(executionId));
  const est = estimateTokens(parsed.system, parsed.user, maxOut);
  const reservation = await budget.reserve(est);
  if (!reservation.ok) {
    log("agent.reserve_denied", {
      request_id: requestId,
      execution: executionId,
      reason: reservation.reason,
    });
    return json(
      { error: "budget_exhausted", reason: reservation.reason, remaining: reservation.remaining },
      429,
    );
  }

  // Broker the call through the model gateway (the AI binding is the auth).
  const req: ModelCompletionRequest = {
    model,
    system: parsed.system,
    user: parsed.user,
    ...(parsed.tools !== undefined ? { tools: parsed.tools as ModelCompletionRequest["tools"] } : {}),
    maxTokens: maxOut,
    ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
  };
  const layer = makeModelGatewayLive(
    env.AI,
    env.AI_GATEWAY_ID,
    env.CLOUDFLARE_ACCOUNT_ID,
  );

  try {
    const result = await Effect.runPromise(
      modelGateway.complete(req).pipe(Effect.provide(layer)),
    );
    const actual = (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
    // Settle: reconcile the held estimate with real usage (fall back to the
    // estimate when the backend reports no usage, so the cap never under-counts).
    // The DO returns the POST-settle remaining, so the agent can self-throttle.
    const remainingAfter = await budget.settle(reservation.held, actual > 0 ? actual : est);
    return json(
      {
        toolCalls: result.toolCalls,
        text: result.text,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        remaining: remainingAfter,
      },
      200,
    );
  } catch (e) {
    // The call failed AFTER reserving — charge the estimate (the attempt cost
    // budget; don't refund, so a failing loop still terminates).
    await budget.settle(reservation.held, est);
    log("agent.model_failed", {
      request_id: requestId,
      execution: executionId,
      detail: String(e).slice(0, 500),
    });
    return json({ error: "model_call_failed", detail: String(e).slice(0, 500) }, 502);
  }
};
