# ADR-0009: Two-tier budgets — the substrate meters executions and caps consumers

- **Status:** Proposed
- **Date:** 2026-08-06

## Context

Both consumers built spend fences at different granularity: fractalbot's `BudgetLedger` is
conversation-scoped and provider-window-aware (per-task dollar cap, "unmeasured is not free",
per-minute token pacing); flare-dispatch's AgentBudget DO meters per execution behind its model
proxy, with typed stop reasons. They meter different loops and neither survives the other's failure:
a buggy or compromised consumer — or a leaked fleet of per-execution tokens — can drain the org's
model budget through a proxy that meters but never refuses. The substrate is the only place a spend
cap holds without consumer cooperation.

## Decision

The substrate's metered model proxy enforces two tiers:

1. **Per-execution metering** — the AgentBudget pattern, keyed by execution, capped by the run's
   declared limits.
2. **Per-consumer ceiling** — a second budget DO keyed by consumer identity on the service binding;
   the hard stop that holds when a consumer's own ledger is wrong.

Budget stops cross the facade as typed refusals carrying meter state — never as opaque model-call
failures. Consumer-side budgets (fractalbot's `BudgetLedger`, its token pacing, all budget UX) stay
consumer-side as the product layer above the floor.

## Consequences

- A BYOC operator gets one place to cap total spend per consumer.
- The substrate needs consumer identity on every facade call — the service binding provides it; the substrate
  never trusts a consumer-supplied identity field.
