# Architecture decision records

Each record settles one direction that the specifications then assume. A record is never edited after acceptance; a superseding decision gets a new record that names the one it replaces. Each record has the sections Status and date, Context, Decision, Options considered, Criteria, Consequences and Revisit triggers.

mameko's records decide the scheduling mechanism FlareDispatch composes. A FlareDispatch record that a mameko record replaces carries the status `Superseded by mameko ADR-NNNN`, or `Superseded in part by mameko ADR-NNNN` where FlareDispatch keeps one of its decisions.

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](0001-local-first-control-plane.md) | Superseded in part by mameko [ADR-0003](https://github.com/fractalboxdev/mameko/blob/2c3041335db0cf4a2193e5b11827f20631d54e87/specs/adr/0003-two-level-scheduling-owned-devices-first.md) | FlareDispatch is a Cloudflare-hosted CI application on mameko |
| [0002](0002-effect-workflow-engine.md) | Superseded by mameko [ADR-0004](https://github.com/fractalboxdev/mameko/blob/2c3041335db0cf4a2193e5b11827f20631d54e87/specs/adr/0004-effect-workflow-owned-backends.md) | Effect v4 Workflow as the single run model, on engine backends this repository owns |
| [0003](0003-run-body-in-executor.md) | Superseded by mameko [ADR-0005](https://github.com/fractalboxdev/mameko/blob/2c3041335db0cf4a2193e5b11827f20631d54e87/specs/adr/0005-run-body-in-executor.md) | Run bodies execute inside the executor; the control plane applies side effects as intents |
| [0004](0004-engine-state-split.md) | Superseded by mameko [ADR-0006](https://github.com/fractalboxdev/mameko/blob/2c3041335db0cf4a2193e5b11827f20631d54e87/specs/adr/0006-journal-and-cross-execution-store.md) | The per-execution journal lives in DO-SQLite; cross-execution state lives in D1 |
| [0005](0005-qos-classes-queue-then-fail.md) | Superseded by mameko [ADR-0007](https://github.com/fractalboxdev/mameko/blob/2c3041335db0cf4a2193e5b11827f20631d54e87/specs/adr/0007-classes-queue-then-fail.md) and [ADR-0017](https://github.com/fractalboxdev/mameko/blob/2c3041335db0cf4a2193e5b11827f20631d54e87/specs/adr/0017-application-profiles.md); the class values live in [profile.md](../profile.md) | QoS classes P0–P3 and queue-then-fail; no capacity outcome concludes `neutral` |
| [0006](0006-executor-aware-spend.md) | Superseded by mameko [ADR-0008](https://github.com/fractalboxdev/mameko/blob/2c3041335db0cf4a2193e5b11827f20631d54e87/specs/adr/0008-executor-aware-spend.md) | Executor-aware spend meter with holds, nested lines and burn lanes |
| [0007](0007-fenced-execution-leases.md) | Superseded by mameko [ADR-0009](https://github.com/fractalboxdev/mameko/blob/2c3041335db0cf4a2193e5b11827f20631d54e87/specs/adr/0009-fenced-execution-leases.md) | Fenced execution leases with epochs; a reclaim restarts the run |
| [0008](0008-executor-transport.md) | Superseded by mameko [ADR-0010](https://github.com/fractalboxdev/mameko/blob/2c3041335db0cf4a2193e5b11827f20631d54e87/specs/adr/0010-executor-transport.md) | An outbound WebSocket to a per-executor Durable Object; Tailscale only between devices |
| [0009](0009-device-isolation.md) | Superseded by mameko [ADR-0011](https://github.com/fractalboxdev/mameko/blob/2c3041335db0cf4a2193e5b11827f20631d54e87/specs/adr/0011-device-isolation.md) and [ADR-0019](https://github.com/fractalboxdev/mameko/blob/2c3041335db0cf4a2193e5b11827f20631d54e87/specs/adr/0019-device-platforms-and-job-runtimes.md) | Owned-device isolation: a VM per job, a dedicated user, egress profiles |
| [0010](0010-agent-implementation.md) | Superseded by mameko [ADR-0012](https://github.com/fractalboxdev/mameko/blob/2c3041335db0cf4a2193e5b11827f20631d54e87/specs/adr/0012-device-executor-implementation.md) | The agent is TypeScript on Effect v4, with a Swift Secure Enclave helper |
| [0011](0011-outbox-and-quota.md) | Superseded in part by mameko [ADR-0013](https://github.com/fractalboxdev/mameko/blob/2c3041335db0cf4a2193e5b11827f20631d54e87/specs/adr/0013-outbox-and-effect-classes.md) | A per-installation quota Durable Object as the applier rate limit for GitHub effects |
| [0012](0012-values-only-overlay.md) | Accepted | A values-only operator overlay and a deploy-time drift check |
| [0013](0013-cache-trust-tiers.md) | Accepted | Cache trust namespaces and a two-level cache |
| [0014](0014-model-routing.md) | Superseded by mameko [ADR-0014](https://github.com/fractalboxdev/mameko/blob/2c3041335db0cf4a2193e5b11827f20631d54e87/specs/adr/0014-model-routing.md) | Model routing by confidentiality mode, task tier and data location |
| [0015](0015-provenance-tiers.md) | Accepted | Provenance tiers; releases pinned to the cloud |
| [0016](0016-run-catalog-scope.md) | Accepted | Gate and agentic recipes in the tree; consumer gates as repo manifests |
| [0017](0017-verification-strategy.md) | Superseded in part by mameko [ADR-0015](https://github.com/fractalboxdev/mameko/blob/2c3041335db0cf4a2193e5b11827f20631d54e87/specs/adr/0015-verification-strategy.md); the CI harness section stays | Conformance suites, deterministic simulation and a replay harness as merge gates |
| [0018](0018-formal-models.md) | Superseded in part by mameko [ADR-0016](https://github.com/fractalboxdev/mameko/blob/2c3041335db0cf4a2193e5b11827f20631d54e87/specs/adr/0016-formal-models.md); the Tamarin model of provenance stays | Lean 4 models of the spend, placement, outbox, staged-write and fencing kernels, linked by differential testing; Tamarin for provenance |

FlareDispatch also builds on these mameko records, which have no FlareDispatch counterpart:

| mameko ADR | Decision |
| --- | --- |
| [0001](https://github.com/fractalboxdev/mameko/blob/2c3041335db0cf4a2193e5b11827f20631d54e87/specs/adr/0001-libraries-device-executor-protocol.md) | Libraries, the device executor and the protocol: no service and no shared instance; consumers pin exact published packages |
| [0002](https://github.com/fractalboxdev/mameko/blob/2c3041335db0cf4a2193e5b11827f20631d54e87/specs/adr/0002-host-neutral-core-two-hosts.md) | Host-neutral core with two equal hosts; FlareDispatch composes `host-cloudflare` |
| [0018](https://github.com/fractalboxdev/mameko/blob/2c3041335db0cf4a2193e5b11827f20631d54e87/specs/adr/0018-installed-and-copied-code.md) | Installed code and copied code: exact-pinned packages, and templates `<cli> add` copies once into the application |
| [0019](https://github.com/fractalboxdev/mameko/blob/2c3041335db0cf4a2193e5b11827f20631d54e87/specs/adr/0019-device-platforms-and-job-runtimes.md) | Device platforms and job runtimes: Apple silicon Macs and Linux machines, `apple-container` or `oci-engine`, the device key in the Secure Enclave, a TPM 2.0 or an allowed software key |
