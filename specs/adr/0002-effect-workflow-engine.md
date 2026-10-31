# ADR-0002: Effect workflow as the single run model, on engine backends built in this repository

Status: Superseded by mameko [ADR-0004](https://github.com/fractalboxdev/mameko/blob/88770c64b14818ad32aed9615f1cfaf4bbc1f591/specs/adr/0004-effect-workflow-owned-backends.md) · 2026-10-24

## Context

- Runs are typed Effect programs with tagged errors and Layer-provided capabilities ([run-model.md](../run-model.md)). They execute in four hosts: the Cloudflare control plane, a runner on each executor, a portable control plane on Postgres, and tests.
- The current dispatcher runs run bodies inside Cloudflare Workflows. Workflows re-executes `run()` from the top on every resume, so every side effect outside `step.do` repeats; a step with no explicit timeout inherits a 10-minute default; the step runner imports `NonRetryableError` from `cloudflare:workflows`; and nothing runs the same engine on a device or in a test.
- No harness today proves that a replay makes zero extra GitHub or D1 calls.
- `effect/workflow` in `effect` 4.0.6 defines `Workflow`, `Activity`, `DurableDeferred`, `DurableClock` and a `WorkflowEngine` service whose low-level contract, `WorkflowEngine.Encoded`, is implemented once per storage backend and wrapped by `WorkflowEngine.makeUnsafe`. The module is marked `@stability unstable`.
- `effect` also ships `WorkflowEngine.layerMemory`, an in-memory engine that keeps its state in closures, and `ClusterWorkflowEngine` in `effect/cluster`, which runs on `SqlMessageStorage` over `effect/sql`, Postgres included.

## Decision

- Every run and the control plane's `Execution` workflow are `effect/workflow` programs: `Workflow.make` for each workflow, `Activity.make` for each step, `DurableDeferred` for each external completion, `DurableClock` for each timed wait.
- This repository builds four backends of `WorkflowEngine.Encoded`: DO-SQLite (the control plane on Cloudflare), SQLite (every runner and local scheduler), Postgres (the portable control plane) and memory (tests) (mameko's [engine.md](https://github.com/fractalboxdev/mameko/blob/88770c64b14818ad32aed9615f1cfaf4bbc1f591/specs/engine.md)). The memory backend is built here, not taken from `WorkflowEngine.layerMemory`, because the replay harness reads and replays journal rows, which `layerMemory` does not expose.
- `effect` is pinned at exactly 4.0.6. An Effect version change merges only through the upgrade gate: the engine conformance suite, the replay of recorded journals, the simulation suite, and the suites of the HTTP API, the `fd` CLI, the MCP tools and the agent's process spawning, which use other `@stability unstable` modules (mameko's [engine.md](https://github.com/fractalboxdev/mameko/blob/88770c64b14818ad32aed9615f1cfaf4bbc1f591/specs/engine.md) § Upgrade gate).
- Cloudflare Workflows is not used.

## Options considered

| Option | Buys | Costs |
| --- | --- | --- |
| Cloudflare Workflows on the control plane, a separate local engine on devices | A managed engine with no backend to build | Two engines with different replay semantics; run bodies tied to `cloudflare:workflows`; no Postgres path; the replay hazards above stay |
| Temporal | A mature engine with a large user base | A cluster of four services with Cassandra, Postgres or MySQL to operate; its TypeScript workers run on Node, not in Workers; a second programming model beside Effect |
| `ClusterWorkflowEngine` on Postgres for the portable control plane | A maintained `effect` backend with no engine code to own | Needs the cluster sharding runtime and runner processes beside Postgres; no Durable Object host, so the Cloudflare control plane still needs its own backend |
| A Postgres-first plane on a durable-execution library (DBOS, Hatchet) | One store for journal and queue | Postgres becomes required on every deploy, including Cloudflare; no Durable Object hibernation or alarms |
| **`effect/workflow` with backends built here** | One run model and one conformance suite across all four hosts; typed errors and schemas end to end | Four backends to build and keep correct; an unstable upstream API |

## Criteria

1. One run program executes unchanged on every host. This criterion decided against Cloudflare Workflows.
2. Replay semantics are testable by one conformance suite with no network.
3. A Cloudflare deploy operates no extra datastore. This criterion decided against Temporal and a Postgres-first plane.
4. Errors and payloads stay typed `Schema` values across the journal boundary.

## Consequences

- The cost accepted is ownership of four engine backends and of the conformance suite that holds them to one contract.
- `@stability unstable` means a patch or minor release of `effect` can change the contract. The exact pin and the upgrade gate turn that risk into a blocked merge instead of a broken in-flight execution.
- Recorded journals per workflow version become repository fixtures that every Effect upgrade replays.
- Leaving Cloudflare Workflows removes the platform's managed retries and dashboard; step retries come from `Activity.retry` with no backoff (a delay between attempts is a `DurableClock` wait), and step history from the journal.

## Revisit triggers

- `effect` marks `effect/workflow` stable, or a shipped backend (`ClusterWorkflowEngine` included) passes the conformance suite on a host that needs no sharding runtime.
- An `effect` 4.x release changes `WorkflowEngine.Encoded` in a way the backends cannot absorb within one release cycle.
- A Durable Object SQLite limit (storage per object, request duration) blocks the `Execution` workflow.
