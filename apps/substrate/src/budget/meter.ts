// The metered model proxy's spend arithmetic — two tiers, one decision
// (specs/adr/0009-two-tier-budgets.md).
//
// ADR-0009's premise is that neither consumer's spend fence survives the
// other's failure: fractalbot meters a conversation, flare-dispatch meters an
// execution, and a buggy or compromised consumer — or a leaked fleet of
// per-execution proxy tokens — drains the org's model budget through a proxy
// that meters but never refuses. The substrate is the only component that can
// hold a cap without consumer cooperation, so it holds two:
//
// 1. **Per-execution** — the run's declared limit. The stop a consumer can act
//    on: this task overspent, the rest of the fleet is fine.
// 2. **Per-consumer** — the ceiling that holds when the consumer's own ledger
//    is wrong. A BYOC operator's one place to cap total spend.
//
// The execution tier is checked first because its refusal is the more useful
// one: a consumer that hits its own execution cap has a bug in one task, and a
// consumer that hits the org ceiling has a bug everywhere. A charge that clears
// the execution tier and fails the ceiling is refunded — the tiers must not
// disagree about what was spent.
//
// **Unmeasured is not free.** A model the price card does not know is charged
// at `UNPRICED_USD_PER_MTOK` rather than at zero. The alternative — treating an
// unpriced model as costless — makes the cheapest way past a budget "call a
// model the card has never heard of", which is also what happens by accident
// every time a provider ships a new model id.
//
// Money is integer micro-USD everywhere state is kept. Floating-point dollars
// accumulate error across thousands of sub-cent charges, and a cap that drifts
// is a cap nobody can reason about; USD only appears at the contract boundary,
// where `BudgetStop.meter` reports it.
//
// Pure. Unit tested in meter.test.ts.
import type { BudgetStop } from "@fractalboxdev/flare-dispatch-substrate-contract";

export type PriceCard = {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
};

/**
 * Published list prices per million tokens. Deliberately a small, explicit map
 * rather than a lookup against a provider API: the price a budget is enforced
 * against must be reviewable in a diff, and a provider outage must not make
 * every call unpriced.
 */
export const PRICE_CARD: Readonly<Record<string, PriceCard>> = Object.freeze({
  "claude-opus-5": { inputUsdPerMTok: 15, outputUsdPerMTok: 75 },
  "claude-sonnet-5": { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  "claude-haiku-4-5-20251001": { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
});

/**
 * What an unknown model costs. Set at the top of the card, not the middle: an
 * unpriced model is an unknown, and the safe direction for an unknown that
 * spends money is to over-charge it and have an operator notice, rather than
 * under-charge it and have the ceiling arrive after the money is gone.
 */
export const UNPRICED_USD_PER_MTOK = 75;

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
};

/** Micro-USD — the unit every stored balance is kept in. */
export type MicroUsd = number;

export const toMicroUsd = (usd: number): MicroUsd => Math.round(usd * 1_000_000);
export const fromMicroUsd = (micro: MicroUsd): number => micro / 1_000_000;

/** Cost of one call in micro-USD, rounded up so a sub-micro call is never free. */
export function usageMicroUsd(model: string, usage: ModelUsage): MicroUsd {
  const card = PRICE_CARD[model] ?? {
    inputUsdPerMTok: UNPRICED_USD_PER_MTOK,
    outputUsdPerMTok: UNPRICED_USD_PER_MTOK,
  };
  const input = Math.max(0, usage.inputTokens);
  const output = Math.max(0, usage.outputTokens);
  const usd =
    (input * card.inputUsdPerMTok + output * card.outputUsdPerMTok) / 1_000_000;
  return Math.ceil(usd * 1_000_000);
}

/**
 * What to hold before a call whose usage is not known yet. The estimate is the
 * reservation: a cap enforced only on settle is not a cap under concurrency,
 * because every in-flight call reads the same remaining balance.
 */
export function reservationMicroUsd(
  model: string,
  estimate: { inputTokens: number; maxOutputTokens: number },
): MicroUsd {
  return usageMicroUsd(model, {
    inputTokens: estimate.inputTokens,
    outputTokens: estimate.maxOutputTokens,
  });
}

/** One tier's state, as the store holds it. */
export type TierState = {
  spentMicroUsd: MicroUsd;
  capMicroUsd: MicroUsd;
};

export type BudgetScope = BudgetStop["scope"];

/** The refusal a spent tier produces, in the contract's own units. */
export function budgetStop(scope: BudgetScope, tier: TierState): BudgetStop {
  return {
    kind: "budget-stop",
    scope,
    meter: {
      spentUsd: fromMicroUsd(tier.spentMicroUsd),
      capUsd: fromMicroUsd(tier.capMicroUsd),
    },
  };
}

export type SpendDecision =
  | { ok: true; chargeMicroUsd: MicroUsd }
  | { ok: false; refusal: BudgetStop };

/**
 * Decide one charge against both tiers, without mutating either.
 *
 * The store applies the same rule atomically — this function is what makes the
 * rule testable and what the store's SQL is written to match. A charge is
 * admitted only when it fits **both** tiers; a tier that is already over its
 * cap refuses every further charge, including a zero one, because "already
 * over" is the state a stop is supposed to be sticky in.
 */
export function decideSpend(
  tiers: { execution: TierState; consumer: TierState },
  chargeMicroUsd: MicroUsd,
): SpendDecision {
  const charge = Math.max(0, chargeMicroUsd);
  if (tiers.execution.spentMicroUsd + charge > tiers.execution.capMicroUsd)
    return { ok: false, refusal: budgetStop("execution", tiers.execution) };
  if (tiers.consumer.spentMicroUsd + charge > tiers.consumer.capMicroUsd)
    return { ok: false, refusal: budgetStop("consumer", tiers.consumer) };
  return { ok: true, chargeMicroUsd: charge };
}
