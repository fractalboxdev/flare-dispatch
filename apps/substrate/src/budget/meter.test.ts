import { describe, expect, it } from "vitest";
import {
  PRICE_CARD,
  UNPRICED_USD_PER_MTOK,
  budgetStop,
  decideSpend,
  fromMicroUsd,
  reservationMicroUsd,
  toMicroUsd,
  usageMicroUsd,
  type TierState,
} from "./meter";

const tier = (spentUsd: number, capUsd: number): TierState => ({
  spentMicroUsd: toMicroUsd(spentUsd),
  capMicroUsd: toMicroUsd(capUsd),
});

describe("usageMicroUsd", () => {
  it("prices a known model off the card", () => {
    const card = PRICE_CARD["claude-sonnet-5"]!;
    const cost = usageMicroUsd("claude-sonnet-5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(fromMicroUsd(cost)).toBeCloseTo(card.inputUsdPerMTok + card.outputUsdPerMTok, 6);
  });

  it("charges an unknown model rather than treating it as free", () => {
    const cost = usageMicroUsd("some-model-shipped-yesterday", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(fromMicroUsd(cost)).toBeCloseTo(UNPRICED_USD_PER_MTOK, 6);
  });

  it("rounds up, so a sub-micro call is never free", () => {
    expect(usageMicroUsd("claude-haiku-4-5-20251001", { inputTokens: 1, outputTokens: 0 })).toBe(1);
  });

  it("treats negative token counts as zero", () => {
    expect(usageMicroUsd("claude-sonnet-5", { inputTokens: -1000, outputTokens: 0 })).toBe(0);
  });
});

describe("reservationMicroUsd", () => {
  it("holds the maximum the call could cost, not the minimum", () => {
    const held = reservationMicroUsd("claude-sonnet-5", {
      inputTokens: 1_000,
      maxOutputTokens: 8_192,
    });
    const actual = usageMicroUsd("claude-sonnet-5", { inputTokens: 1_000, outputTokens: 200 });
    expect(held).toBeGreaterThan(actual);
  });
});

describe("decideSpend — two tiers", () => {
  it("admits a charge that fits both", () => {
    const d = decideSpend({ execution: tier(0, 1), consumer: tier(0, 100) }, toMicroUsd(0.5));
    expect(d.ok).toBe(true);
  });

  it("reports the execution tier first — the stop a consumer can act on", () => {
    const d = decideSpend({ execution: tier(0.9, 1), consumer: tier(99.9, 100) }, toMicroUsd(0.5));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal.scope).toBe("execution");
  });

  it("stops at the consumer ceiling when the execution still has room", () => {
    const d = decideSpend({ execution: tier(0, 100), consumer: tier(99.9, 100) }, toMicroUsd(0.5));
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.refusal.scope).toBe("consumer");
      expect(d.refusal.meter).toEqual({ spentUsd: 99.9, capUsd: 100 });
    }
  });

  it("stays stopped once a tier is over its cap, even for a zero charge", () => {
    const d = decideSpend({ execution: tier(1.5, 1), consumer: tier(0, 100) }, 0);
    expect(d.ok).toBe(false);
  });

  it("admits a charge that exactly fills the cap", () => {
    expect(decideSpend({ execution: tier(0.5, 1), consumer: tier(0, 100) }, toMicroUsd(0.5)).ok).toBe(
      true,
    );
  });
});

describe("budgetStop", () => {
  it("renders meter state in the contract's USD, not the store's micro-USD", () => {
    expect(budgetStop("consumer", tier(2.5, 10))).toEqual({
      kind: "budget-stop",
      scope: "consumer",
      meter: { spentUsd: 2.5, capUsd: 10 },
    });
  });
});
