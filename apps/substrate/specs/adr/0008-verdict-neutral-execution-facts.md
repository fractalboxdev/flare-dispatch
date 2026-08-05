# ADR-0008: The substrate is verdict-neutral — execution facts only

- **Status:** Accepted
- **Date:** 2026-08-06

## Context

flare-dispatch's runs end in a terminal CI verdict feeding check-runs; fractalbot's tasks move
through conversational states (`active` / `awaiting_human` / `done`) feeding a Slack thread. The
founding analysis identified the verdict-model mismatch as one of the two reasons merging either
product into the other fails, and the review panel answered the open question unanimously: a
verdict-bearing substrate re-imports the mismatch through the back door, forces every future
consumer to map its semantics onto one product's CI vocabulary, and enlarges the data the substrate holds
about consumers — exactly what the tenancy posture wants to avoid.

## Decision

The substrate reports **typed execution facts** and nothing else: exit codes, durations, generations,
output tails and artifact refs, meter state, denial events, admission timings, and infrastructure
outcomes (admitted/refused, killed, revoked, budget-exhausted). Verdicts are consumer semantics,
permanently — this is a non-goal, not a deferral.

## Consequences

- Consumers fold facts into their own outcome models; the substrate's types never carry Slack, GitHub, or
  CI vocabulary.
- The substrate's logs stay execution-scoped, which keeps the never-store list (ADR-0006) enforceable and
  the substrate neutral for any later consumer.
