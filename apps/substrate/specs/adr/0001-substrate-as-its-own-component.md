# ADR-0001: The execution substrate is its own component

- **Status:** Accepted
- **Date:** 2026-08-06

## Context

fractalbot and flare-dispatch were building the same execution
environment twice: sandbox admission, CF Workflows quirks (instance-id sanitization, step
idempotency, result clamps), container-FS-is-not-durable → R2 externalization, hand-built toolchain
images, and two bespoke model stacks. Security maturity is inverted: fractalbot's egress engine
(deny-all, recipe-asserted grants, redirect re-policing) is built and reviewed but never ran in
production; flare-dispatch's fleet is production-hardened (~30 dogfooding PRs) but has zero egress
enforcement and injects secrets into the command env.

Two facts rule out merging either product into the other. The control loops do not unify:
`RunWorkflow` executes a frozen program to a terminal verdict, while fractalbot's `TaskWorkflow`
phones its conversation DO's planner every step with humans approving mid-run. And admission is a
shared-ceiling correctness problem: both fleets draw on one account-level Containers ceiling with no
view of each other — flare-dispatch owns a real D1 FIFO semaphore, fractalbot an advisory fail-open
check, and *no component owns the ceiling*.

## Decision

Split into three components with one-way dependencies: fractalbot (Slack surface), flare-dispatch
(agentic runs: triggers, verdicts, sinks), and **the substrate** — the execution substrate this repo
implements. The substrate owns containers and image classes, admission, egress policy and credentials, R2
artifacts, and the metered model proxy. Consumers keep their loops, verdicts, and product semantics
and drive the substrate through a narrow facade.

## Consequences

- One admission path can own the account ceiling (ADR-0004); one egress engine is audited once
  (ADR-0005) and every workload inherits the stricter threat model as a floor.
- The substrate must stay consumer-neutral: no verdicts (ADR-0008), no Slack or GitHub semantics in its
  types, execution facts only.
