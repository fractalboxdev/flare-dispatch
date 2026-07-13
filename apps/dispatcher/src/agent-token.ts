// FlareDispatch Dispatcher — per-execution agent model-proxy capability tokens.
//
// The model-proxy (`POST /v1/agent/:execution/inference`) lets an in-sandbox
// coding agent reach a model WITHOUT holding a model API key — the Worker (which
// holds the AI binding) brokers the call. The agent authenticates with a
// capability token bound to its execution id, minted by the run and injected as
// `$FLARE_MODEL_PROXY` auth. Same construction as the log-viewer token
// (`log-token.ts`) — HKDF-derived, HMAC over the execution id — but a DISTINCT
// `info` label so an agent token can never be confused with, or forged from, a
// log token even though both can derive from `HMAC_SECRET`.
//
// The token authenticates; the *state* (liveness, remaining budget, rate limit)
// lives in the AgentBudget DO — a stateless token can't hold it (security review
// #1). A leaked token therefore buys, at most, that execution's remaining budget.
//
// Spec: specs/08-self-healing.md § 6.3, § 10.2.

import { makeCapabilityToken } from "./capability-token";
import type { Env } from "./env";

/** Domain-separation label — DISTINCT from the log token's. */
const HKDF_INFO = "flare-dispatch/agent-proxy/v1";

const token = makeCapabilityToken(HKDF_INFO);

/**
 * Key material for the agent token: a dedicated `AGENT_PROXY_SECRET`, else the
 * shared `HMAC_SECRET` (present on every Action-mode deploy). The HKDF label
 * keeps the derived key independent of both the raw dispatch HMAC and the log
 * token. Neither set ⇒ `undefined` ⇒ the route default-denies (503).
 */
export const resolveAgentProxySecret = (env: Env): string | undefined => {
  const dedicated = env.AGENT_PROXY_SECRET;
  if (typeof dedicated === "string" && dedicated.length > 0) return dedicated;
  const hmac = env.HMAC_SECRET;
  if (typeof hmac === "string" && hmac.length > 0) return hmac;
  return undefined;
};

/** Mint the agent capability token for `executionId`. */
export const signAgentToken = token.sign;

/** Verify a presented token for `executionId` (constant-time). */
export const verifyAgentToken = token.verify;

/** Extract a bearer token from the Authorization header (or `?token=`). */
export const callerAgentToken = (request: Request, url: URL): string | null => {
  const auth = request.headers.get("authorization");
  if (auth !== null) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m !== null) return m[1]!.trim();
  }
  return url.searchParams.get("token");
};
