# ADR-0014 — Typed model tools and a per-execution token allowance

**Status:** proposed 2026-11-08
**Related:** `packages/core/src/services/model-gateway.ts` · `packages/runtime-cf/src/model-gateway-cf.ts` · `packages/core/src/agent-budget.ts` · `apps/dispatcher/src/agent-budget-do.ts` · `apps/dispatcher/src/routes/agent-inference.ts` · `packages/review-agent/src/engine.ts` · ADR-0006 · ADR-0010

## Context

- Runs call models through `modelGateway.complete`, one turn per call.
- `review-agent` passes a single `report` tool and reads its arguments
  (`engine.ts`). No run gives a model tools that act on the workspace, so a
  reviewer sees only the diff.
- Only `self-heal-pr` has a hard token cap. Its `AgentBudget` Durable Object
  reserves tokens before each proxied call (`agent-budget-do.ts`).
- Calls made from the Worker have no per-execution cap. ADR-0006 meters their
  tokens into month-to-date spend. A run with a retry or loop bug spends until
  the monthly budget closes admission for every run.
- A per-call `maxTokens` bounds one call's output, not an execution's total.

## Decision

### Per-execution token allowance

- Every execution has a model token allowance, counting input and output.
  - `limits.modelTokens` sets it per run.
  - `CONFIG_KV` `model.tokens:<run>` overrides it.
  - Unset, it is `MODEL_TOKENS_PER_EXECUTION`, 500,000 by default.
- The `AgentBudget` Durable Object becomes the execution model allowance,
  one instance per execution, for every run. The self-heal proxy and the
  Worker-side gateway reserve against the same instance.
- Before each call, the gateway reserves the estimated input tokens plus the
  call's `maxTokens`. A reservation that exceeds the remaining allowance fails
  with `ModelAllowanceExhausted`, before any request reaches a provider. After
  the call, the gateway settles the reservation to the metered usage.
- `ModelAllowanceExhausted` concludes the check-run `failure`.
  - The summary states the allowance, the tokens used, and the setting that
    raises it.
  - A run must not convert it into `RunSkipped`.
  - `RunSkipped` is `neutral` because it reports a platform capacity limit.
    An exhausted allowance reports the run's own configuration or a loop bug.
    A `neutral` check would let a pull request merge with no verdict.

### Typed model tools

- `tool(name, description, input, output, handler)` defines a model tool:
  - `input` and `output` are Effect Schemas;
  - `handler` is an Effect over `RunContext`, so a tool runs a sandbox
    command, reads a workspace file, or reads an artifact through the run's
    capabilities.
- The tool's JSON schema for the provider derives from `input`.
- A model's tool arguments are decoded with `input` before `handler` runs. A
  decode failure returns to the model as a tool error and is not a defect.
- A tool's output is encoded with `output` and truncated to 32 KiB. The
  truncation is stated in the returned text.

### The agent loop

- `agentLoop({ model, system, tools, maxSteps })` is the one primitive for a
  multi-turn tool loop. Each turn is a `step`, so a Workflows replay does not
  repeat paid calls.
- Exceeding `maxSteps` fails with `AgentStepsExhausted`.

## Options considered

- **Per-loop caps only: `maxSteps` and per-call `maxTokens`.** Agent SDKs and
  build-engine LLM primitives take this approach. Two examples: an agent
  SDK's maximum turn count, and Dagger's `loop(maxSteps, maxTokens)`, which
  limits steps and one step's output. It bounds a loop but not an execution,
  which may run several loops and single calls.
- **Rely on ADR-0006's monthly budget.** It stops a runaway execution only
  after it has spent from every other run's month.
- **Per-execution allowance in the gateway, plus typed tools (chosen).** It
  costs one Durable Object round trip per model call, and an allowance
  default that each heavy agent run must raise.

## Criteria

1. A single execution cannot spend more than its stated allowance.
2. Tool input from a model is validated before it touches a capability.
3. Model calls are not repeated on a Workflows replay.

Criterion 1 decided against per-loop caps and against relying on the monthly
budget.

## Consequences

- `review-agent` can read files and run commands in the sandbox through
  typed tools, instead of reviewing the diff alone.
- A loop bug costs at most one allowance, not a month's budget.
- **Accepted cost:** every model call makes a Durable Object round trip, and
  runs that need more than the default allowance declare it.

## Revisit triggers

- Allowance exhaustion concludes more than 1% of executions in a week.
- A provider exposes a native per-key spend cap that the gateway can set per
  execution.
