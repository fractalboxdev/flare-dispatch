// Unit coverage for the pure agent token-budget state machine. No DO, no
// network — the DO wraps these decisions transactionally.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_MAX_REQUESTS,
  DEFAULT_AGENT_TOKEN_BUDGET,
  decideReserve,
  initialBudget,
  kill,
  remaining,
  settle,
  type AgentBudgetState,
} from "./agent-budget";

describe("agent-budget", () => {
  it("starts with the documented defaults", () => {
    const s = initialBudget();
    expect(s.tokenBudget).toBe(DEFAULT_AGENT_TOKEN_BUDGET);
    expect(s.maxRequests).toBe(DEFAULT_AGENT_MAX_REQUESTS);
    expect(remaining(s)).toBe(DEFAULT_AGENT_TOKEN_BUDGET);
    expect(s.live).toBe(true);
  });

  it("honors explicit budget + request caps", () => {
    const s = initialBudget({ tokenBudget: 1000, maxRequests: 2 });
    expect(s.tokenBudget).toBe(1000);
    expect(s.maxRequests).toBe(2);
  });

  it("reserve holds the estimate against remaining", () => {
    const s = initialBudget({ tokenBudget: 100 });
    const d = decideReserve(s, 30);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.held).toBe(30);
      expect(remaining(d.state)).toBe(70);
      expect(d.state.requests).toBe(1);
    }
  });

  it("two concurrent reserves cannot both pass on the same remaining (hard cap)", () => {
    let s = initialBudget({ tokenBudget: 100 });
    const a = decideReserve(s, 60);
    expect(a.ok).toBe(true);
    if (a.ok) s = a.state; // single-writer applies the first
    const b = decideReserve(s, 60); // only 40 remaining now
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("budget-exhausted");
  });

  it("settle swaps the estimate for actual usage", () => {
    let s = initialBudget({ tokenBudget: 100 });
    const d = decideReserve(s, 50);
    if (d.ok) s = settle(d.state, d.held, 20); // actual was 20, not 50
    expect(s.spent).toBe(20);
    expect(s.reserved).toBe(0);
    expect(remaining(s)).toBe(80);
  });

  it("an over-budget actual is still charged in full", () => {
    let s = initialBudget({ tokenBudget: 100 });
    const d = decideReserve(s, 50);
    if (d.ok) s = settle(d.state, d.held, 130);
    expect(s.spent).toBe(130);
    expect(remaining(s)).toBe(0);
    expect(decideReserve(s, 1).ok).toBe(false);
  });

  it("denies once not live", () => {
    const s = kill(initialBudget());
    const d = decideReserve(s, 1);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("not-live");
  });

  it("enforces the request cap independent of token budget", () => {
    let s = initialBudget({ tokenBudget: 1_000_000, maxRequests: 2 });
    for (let i = 0; i < 2; i++) {
      const d = decideReserve(s, 1);
      expect(d.ok).toBe(true);
      if (d.ok) s = d.state;
    }
    const d = decideReserve(s, 1);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("too-many-requests");
  });

  it("clamps a zero/negative estimate to 1 (still consumes a request)", () => {
    const s: AgentBudgetState = initialBudget({ tokenBudget: 100, maxRequests: 5 });
    const d = decideReserve(s, 0);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.held).toBe(1);
      expect(d.state.requests).toBe(1);
    }
  });
});
