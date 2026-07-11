// @fractalbox/flare-dispatch-core — the per-execution agent token-budget, pure decision
// logic.
//
// The self-heal model-proxy (`POST /v1/agent/:execution/inference`) must cap how
// many model tokens + requests a single agent run can spend, and refuse once the
// run is no longer live. A naive `read budget → call → decrement` over an
// eventually-consistent store (KV) races across isolates/colos and over-spends
// (security review #1). So the budget lives in a single-writer, strongly
// consistent Durable Object; this module is the PURE state machine the DO wraps,
// the same split `run-admission.ts` / `container-lease.ts` keep — exercised by
// plain vitest, no DO, no network.
//
// Lifecycle: init (run start) → reserve (before each model call) → settle (after,
// reconcile estimate↔actual) → kill (run end). A reservation holds the ESTIMATE
// against the budget immediately so concurrent calls can't both pass on the same
// remaining; settle swaps the estimate for the real usage.
//
// Spec: specs/08-self-healing.md § 6.3 (AgentBudget DO) + § 9.

/** The budget state the DO persists. All token counts are model tokens. */
export type AgentBudgetState = {
  /** Hard token cap for the whole run. `reserve` fails once committed ≥ this. */
  readonly tokenBudget: number;
  /** Tokens already settled (actual usage of completed calls). */
  readonly spent: number;
  /** Tokens currently held by in-flight reservations (estimates). */
  readonly reserved: number;
  /** Max number of model calls for the run (a free-LLM-gateway guard). */
  readonly maxRequests: number;
  /** Requests started so far (a reservation counts immediately). */
  readonly requests: number;
  /** Whether the run is still live. `kill` sets false; reserve then denies. */
  readonly live: boolean;
};

/** Defaults when a run starts a budget without explicit values. */
export const DEFAULT_AGENT_TOKEN_BUDGET = 200_000;
export const DEFAULT_AGENT_MAX_REQUESTS = 64;

export const initialBudget = (opts?: {
  tokenBudget?: number;
  maxRequests?: number;
}): AgentBudgetState => ({
  tokenBudget: opts?.tokenBudget ?? DEFAULT_AGENT_TOKEN_BUDGET,
  spent: 0,
  reserved: 0,
  maxRequests: opts?.maxRequests ?? DEFAULT_AGENT_MAX_REQUESTS,
  requests: 0,
  live: true,
});

/** Tokens still spendable = budget − (settled + held). */
export const remaining = (s: AgentBudgetState): number =>
  Math.max(0, s.tokenBudget - s.spent - s.reserved);

export type ReserveDecision =
  | { readonly ok: true; readonly state: AgentBudgetState; readonly held: number }
  | {
      readonly ok: false;
      readonly reason: "not-live" | "budget-exhausted" | "too-many-requests";
      readonly state: AgentBudgetState;
    };

/**
 * Decide whether a model call may proceed and, if so, hold `estTokens` against
 * the budget. Pure: returns the next state. The DO applies this transactionally
 * (single-writer), which is what makes the cap HARD — two concurrent calls
 * cannot both see the same `remaining`.
 *
 * `estTokens` is clamped to ≥ 1 so a zero-estimate call still consumes a request
 * slot and can't be used to bypass the request cap.
 */
export const decideReserve = (
  s: AgentBudgetState,
  estTokens: number,
): ReserveDecision => {
  if (!s.live) return { ok: false, reason: "not-live", state: s };
  if (s.requests >= s.maxRequests)
    return { ok: false, reason: "too-many-requests", state: s };
  const held = Math.max(1, Math.floor(estTokens));
  if (held > remaining(s))
    return { ok: false, reason: "budget-exhausted", state: s };
  return {
    ok: true,
    held,
    state: { ...s, reserved: s.reserved + held, requests: s.requests + 1 },
  };
};

/**
 * Reconcile a held reservation with the call's ACTUAL token usage: release the
 * held estimate, charge the real amount to `spent`. `actualTokens` is clamped to
 * ≥ 0; an over-budget actual (a model that ran long) is still charged in full so
 * the next reserve sees the true remaining (it just can't be reserved again).
 */
export const settle = (
  s: AgentBudgetState,
  held: number,
  actualTokens: number,
): AgentBudgetState => {
  const charge = Math.max(0, Math.floor(actualTokens));
  return {
    ...s,
    reserved: Math.max(0, s.reserved - held),
    spent: s.spent + charge,
  };
};

/** Mark the run no longer live — subsequent reserves deny with `not-live`. */
export const kill = (s: AgentBudgetState): AgentBudgetState => ({
  ...s,
  live: false,
});
