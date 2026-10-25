# Architecture decision records

Each record settles one direction that the specifications then assume. A record is never edited after acceptance; a superseding decision gets a new record that names the one it replaces. Each record has the sections Status and date, Context, Decision, Options considered, Criteria, Consequences and Revisit triggers.

| ADR | Decision |
| --- | --- |
| [0001](0001-local-first-control-plane.md) | Local-first execution with a Cloudflare control plane; fleet-first; two-level scheduling |
| [0002](0002-effect-workflow-engine.md) | Effect v4 Workflow as the single run model, on engine backends this repository owns |
| [0003](0003-run-body-in-executor.md) | Run bodies execute inside the executor; the control plane applies side effects as intents |
| [0004](0004-engine-state-split.md) | The per-execution journal lives in DO-SQLite; cross-execution state lives in D1 |
| [0005](0005-qos-classes-queue-then-fail.md) | QoS classes P0–P3 and queue-then-fail; no capacity outcome concludes `neutral` |
| [0006](0006-executor-aware-spend.md) | Executor-aware spend meter with holds, nested lines and burn lanes |
| [0007](0007-fenced-execution-leases.md) | Fenced execution leases with epochs; a reclaim restarts the run |
| [0008](0008-executor-transport.md) | An outbound WebSocket to a per-executor Durable Object; Tailscale only between devices |
| [0009](0009-device-isolation.md) | Owned-device isolation: a VM per job, a dedicated user, egress profiles |
| [0010](0010-agent-implementation.md) | The agent is TypeScript on Effect v4, with a Swift Secure Enclave helper |
| [0011](0011-outbox-and-quota.md) | A transactional outbox and a per-installation quota Durable Object for GitHub effects |
| [0012](0012-values-only-overlay.md) | A values-only operator overlay and a deploy-time drift check |
| [0013](0013-cache-trust-tiers.md) | Cache trust namespaces and a two-level cache |
| [0014](0014-model-routing.md) | Model routing by confidentiality mode, task tier and data location |
| [0015](0015-provenance-tiers.md) | Provenance tiers; releases pinned to the cloud |
| [0016](0016-run-catalog-scope.md) | Gate and agentic recipes in the tree; consumer gates as repo manifests |
| [0017](0017-verification-strategy.md) | Conformance suites, deterministic simulation and a replay harness as merge gates |
| [0018](0018-formal-models.md) | Lean 4 models of the spend, placement, outbox, staged-write and fencing kernels, linked by differential testing; Tamarin for provenance |
