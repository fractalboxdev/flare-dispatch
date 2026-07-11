// FlareDispatch Dispatcher — the AgentBudget Durable Object.
//
// One instance per self-heal execution (addressed by `idFromName(executionId)`).
// It is the single-writer, strongly-consistent home for the per-execution model
// token budget, request cap, and liveness that the model-proxy
// (`/v1/agent/:execution/inference`) checks on every call. KV can't do this —
// it is eventually consistent, so a `read → call → decrement` loop across
// isolates over-spends (security review #1). The DO serializes every reserve so
// the cap is HARD.
//
// All decision logic is the pure `@fractalbox/flare-dispatch-core` state machine
// (`agent-budget.ts`); this class only persists the state and applies those
// transitions under the DO's single-threaded guarantee.
//
// Spec: specs/08-self-healing.md § 6.3.

import { DurableObject } from "cloudflare:workers";
import {
  decideReserve,
  initialBudget,
  kill,
  remaining,
  settle,
  type AgentBudgetState,
} from "@fractalbox/flare-dispatch-core";
import type { Env } from "./env";

const STATE_KEY = "state";

type ReserveResult =
  | { readonly ok: true; readonly held: number; readonly remaining: number }
  | {
      readonly ok: false;
      readonly reason: "not-live" | "budget-exhausted" | "too-many-requests";
      readonly remaining: number;
    };

export class AgentBudget extends DurableObject<Env> {
  /** Load persisted state, or `undefined` when the run never called `init`. */
  private async load(): Promise<AgentBudgetState | undefined> {
    return this.ctx.storage.get<AgentBudgetState>(STATE_KEY);
  }

  private async save(s: AgentBudgetState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, s);
  }

  /**
   * Arm the budget at run start. Idempotent-ish: re-init before any spend
   * resets; re-init after spend is ignored (a retry of the start step must not
   * refill a partially-spent budget).
   */
  async init(opts: { tokenBudget?: number; maxRequests?: number }): Promise<void> {
    const existing = await this.load();
    if (existing !== undefined && (existing.spent > 0 || existing.requests > 0)) {
      return; // already spending — don't refill on a retried init
    }
    await this.save(initialBudget(opts));
  }

  /**
   * Reserve `estTokens` before a model call. Single-writer (the DO runs one
   * request at a time), so two concurrent reserves can't both pass on the same
   * remaining. An un-init'd budget reserves against the defaults (fail-safe:
   * the proxy still caps even if `init` was skipped).
   */
  async reserve(estTokens: number): Promise<ReserveResult> {
    const s = (await this.load()) ?? initialBudget();
    const d = decideReserve(s, estTokens);
    if (!d.ok) {
      return { ok: false, reason: d.reason, remaining: remaining(d.state) };
    }
    await this.save(d.state);
    return { ok: true, held: d.held, remaining: remaining(d.state) };
  }

  /** Reconcile a held reservation with the call's actual token usage. */
  async settle(held: number, actualTokens: number): Promise<number> {
    const s = await this.load();
    if (s === undefined) return 0;
    const next = settle(s, held, actualTokens);
    await this.save(next);
    return remaining(next); // post-settle headroom, so the proxy can report it honestly
  }

  /** Mark the run no longer live (run end) — subsequent reserves deny. */
  async kill(): Promise<void> {
    const s = await this.load();
    if (s === undefined) return;
    await this.save(kill(s));
  }

  /** Read-only snapshot (operator/debug). */
  async status(): Promise<AgentBudgetState | undefined> {
    return this.load();
  }
}
