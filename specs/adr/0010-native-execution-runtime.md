# ADR-0010 — Native execution runtime: runs keep Workflows and the sandbox, with no external CI engine or hosted control plane

**Status:** proposed 2026-11-08
**Related:** `packages/core/src/define-run.ts` · `packages/core/src/step.ts` · `packages/runtime-cf/src/sandbox-cf.ts` · `packages/runtime-cf/src/cache-r2.ts` · ADR-0001 · ADR-0007 · ADR-0011 · ADR-0012 · ADR-0013 · ADR-0014

## Context

A run is an Effect program that executes in the dispatcher Worker as one
Cloudflare Workflows instance (ADR-0001). Each `step` is a `WorkflowStep.do`
checkpoint. Commands run in a `@cloudflare/sandbox` container through `exec`.
Dependency trees and Rust compile output are cached in R2 under per-repository
and per-lane keys (ADR-0007).

Established CI engines and build systems offer five capabilities this runtime
lacks:

| Capability | Where it exists elsewhere |
| --- | --- |
| Skip work whose inputs are unchanged | Bazel and Buck2 action caches, Turborepo and Nx task hashing, Dagger's function cache |
| Checks as gates, with per-test results | Buildkite Test Engine, GitHub Actions test reporters, Dagger checks with one OpenTelemetry span per test |
| The same result on a laptop and in CI | Dagger, Earthly, Bazel; `act` for GitHub Actions workflows |
| Model tools typed from code | Agent SDKs; Dagger's LLM type, which exposes an object's methods as tools |
| A hard cap on what one execution spends | Few offer it; most cap a loop's steps, not an execution's tokens |

## Decision

FlareDispatch adopts no external CI engine, build system or hosted CI control
plane as its runtime.

- Runs keep the existing runtime: the Effect run program in the Worker,
  Workflows steps, and sandbox `exec`.
- The five capabilities are built natively, one record each:

| Capability | Record |
| --- | --- |
| Skip unchanged work | ADR-0011, execution-level reuse keyed by declared inputs |
| Checks as gates, per-test results | ADR-0012, typed check reports rendered by the dispatcher |
| Local parity | ADR-0013, local execution of a run definition |
| Typed model tools, per-execution cap | ADR-0014, typed model tools and a per-execution token allowance |

## Options considered

Each option below is a class of system. The examples share the property that
decides the class.

- **A container build engine as the executor** (Dagger; Earthly and
  `docker buildx bake`, both on BuildKit).
  - Buys a typed graph of container operations, a per-operation cache and,
    for Dagger, a catalogue of toolchain modules.
  - Costs:
    - **The engine needs root and netfilter.** It runs privileged and builds a
      bridge network for its steps with iptables. Cloudflare Containers do not
      support iptables manipulation, so the engine runs in host-network mode
      only, and its steps share one network namespace.
    - **Its value is a warm local cache, and container disk is ephemeral**
      (ADR-0001). Dagger's self-hosting guidance says: "Do not run engines on a
      pool of ephemeral machines." Sharing a cache across engines is a feature
      of the vendor's hosted service.
  - Lost on cost per verdict. The cache benefit needs a disk this platform
    does not keep.
- **A build system with remote execution and a remote cache** (Bazel or Buck2
  over the Remote Execution API, with a self-hosted or hosted cache).
  - Buys the finest-grained reuse and hermetic builds.
  - Costs: every target repository must be rewritten into the build system's
    rules first. FlareDispatch serves repositories as they are; it cannot
    impose a build system on them.
  - Lost on criterion 3. It also fails the zero-change onboarding that `check`
    and `offload-test` provide today.
- **Hybrid CI: a vendor control plane with self-hosted agents** (GitHub
  Actions self-hosted runners and Actions Runner Controller, Buildkite agents,
  GitLab runners).
  - Buys mature scheduling, UI and ecosystem.
  - Costs:
    - the control plane, the pipeline state and the logs live with the vendor;
    - the pipeline definition lives in the target repository, so a pull
      request edits the pipeline that judges it;
    - agents need long-lived hosts or a Kubernetes cluster, not Workers.
  - Lost on criteria 1 and 3.
- **Kubernetes-native pipelines** (Tekton, Argo Workflows).
  - Buys a self-hosted control plane with no vendor in the path.
  - Costs: the deploying organization runs a Kubernetes cluster, which
    replaces `wrangler deploy` with cluster operations.
  - Lost on the deploy model: a single `wrangler deploy` into the
    organization's Cloudflare account.
- **A general durable-execution server in place of Workflows** (Temporal).
  - Buys richer workflow semantics.
  - Costs: a server or a hosted service to run beside the Worker. It replaces
    the orchestration layer only, and still needs an executor.
  - Lost on criterion 1 when hosted, and on operating cost when self-hosted.
    Workflows already provides the durability runs use (ADR-0001).
- **Native adoption (chosen).**
  - Keeps one runtime, one deploy and one trust model.
  - Costs:
    - result reuse is coarser than an action or operation cache: one
      execution, not one action;
    - each toolchain needs a primitive written in this repository
      (`installCached`, `sharded`, `oxlint` today), where an engine ships a
      catalogue.

## Criteria

1. Runs inside the deploying organization's Cloudflare account, with no
   third-party control plane.
2. Commands run in unprivileged containers with per-execution egress control.
3. The operator defines what runs: run definitions in `runs/`, deployed with
   the Worker, never read from the pull request under test, and no rewrite of
   the target repository's build.
4. Cost per verdict.

Criteria 1 and 3 decided it. Criterion 4 removed the container build engines
on its own.

## Consequences

- Result reuse, typed check reports, local execution and typed model tools
  are built in this repository, with the scope ADR-0011 to ADR-0014 state.
- Toolchain coverage grows one primitive at a time.
- A pull request never changes the pipeline that judges it.

## Revisit triggers

- Cloudflare Containers allow netfilter in the instance, or offer local disk
  that survives a stop.
- A deploying organization runs FlareDispatch primarily on long-lived hosts
  or a Kubernetes cluster it already operates.
- A container build engine ships a self-hosted scheduler and a shared cache
  with no hosted service in the path.
