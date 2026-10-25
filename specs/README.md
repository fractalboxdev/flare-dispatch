# FlareDispatch specifications

FlareDispatch is local-first CI/CD that an organization deploys into its own Cloudflare account. Cloudflare is the control plane: it receives triggers, classifies and meters work, leases it to an executor and reports the verdict to GitHub. Execution runs first on hardware the organization owns, and spills to Cloudflare Containers and then to outside launchers when owned capacity cannot meet a deadline. These files specify that system; the [ADRs](adr/README.md) record why it has this shape.

## Index

| File | Specifies | Phase |
| --- | --- | --- |
| [architecture.md](architecture.md) | Components, trust zones, data flow, what runs where | 0–4 |
| [run-model.md](run-model.md) | `defineRun`, capabilities → primitives → recipes, `RunResult`, error taxonomy, intents | 0–1 |
| [engine.md](engine.md) | `WorkflowEngine` backends, journal schema, determinism rules, upgrade gate | 0–4 |
| [intake.md](intake.md) | Triggers, signatures, atomic dedup, repo manifests | 0–3 |
| [qos-admission.md](qos-admission.md) | Classes P0–P3, placement constraints, admission, deadlines, supersession, serial groups | 0–4 |
| [spend.md](spend.md) | Executor-aware meter, holds, nested class lines, burn lanes, model allowances, operator halt | 0–3 |
| [placement-leases.md](placement-leases.md) | Executor registry, placement, execution lease with epochs, capacity lease, slot ledger, preemption | 0–4 |
| [executor-protocol.md](executor-protocol.md) | Wire messages, versioning, heartbeat, progress, result submission, reconnect, self-fence | 0–4 |
| [executors.md](executors.md) | Cloudflare Container, owned device, AWS launcher, GitHub Actions launcher | 0–4 |
| [isolation-egress.md](isolation-egress.md) | VM per job, agent user, network isolation, egress profiles, per-lease credentials | 0–4 |
| [cache-artifacts.md](cache-artifacts.md) | Two-level cache, trust namespaces, cache keys, artifacts, retention | 0–2 |
| [github-output.md](github-output.md) | Check-run lifecycle, conclusion mapping, outbox, quota, sweeps, merge queue | 0–2 |
| [model-gateway.md](model-gateway.md) | Task tiers, confidentiality modes, allowances, local model route | 0–4 |
| [local-scheduler.md](local-scheduler.md) | Device scheduler, local classes, rehearsal, `fd` CLI on the device | 1–2 |
| [interfaces.md](interfaces.md) | HTTP API, `fd` CLI, MCP tools | 0–4 |
| [provenance.md](provenance.md) | Statements, provenance tiers, countersignature, transparency log, verification policy | 0–4 |
| [operability.md](operability.md) | BYOC deploy, operator overlay, drift check, liveness, alerts, dashboard, operator controls | 0–3 |
| [runs/gate.md](runs/gate.md) | Gate and test recipes, the job-matrix primitive, exit-to-conclusion rules | 0–2 |
| [runs/agentic.md](runs/agentic.md) | Agentic recipes, staged writeback, path allowlist, secret scan, trifecta rule | 0–4 |
| [verification.md](verification.md) | Requirement → method → harness → phase gate; formal properties → theorems | — |
| [roadmap.md](roadmap.md) | Phases 0–4, gates, kill criteria, requirements each phase closes | — |

## Glossary

Each term has one meaning in every file. A file that needs a new term adds it here.

| Term | Meaning |
| --- | --- |
| **Control plane** | The Workers, Durable Objects, D1 database, KV namespaces and R2 buckets in the deploying organization's Cloudflare account. It holds every credential that can change GitHub or spend money. |
| **Executor** | A place that runs one execution at a time per slot: a Cloudflare Container pool, an owned device, or a launcher (AWS, GitHub Actions). |
| **Executor kind** | One of `cloudflare`, `device`, `aws`, `gha`. The kind decides the price, the isolation and which placement constraints apply. |
| **Capability manifest** | The record an executor registers: its kind, the capability services its Layers serve, its capability labels, its platform and the image digests that passed the exec probe. Placement removes every executor whose manifest lacks a service in the run's `requires` or a label it declares. |
| **Capability label** | A named executor feature a run may require (`linux-amd64`, `linux-arm64`, `macos-arm64`, `xcode`, `browser`, `detached-process`, `expose-port`, `container-artifact`, `local-model`, `oci-build`), from the set in executors.md. |
| **Executor DO** | The Durable Object, one per executor, that accepts the executor's outbound WebSocket through the Hibernation API, runs the claim CAS, records heartbeats, stages the intents of the current epoch, accepts results and holds the lease-expiry alarm and the restart anchor. |
| **Restart anchor** | The `anchor_at` time an executor DO records when it activates after a restart that dropped its sockets. A lease expires at max(last heartbeat, `anchor_at`) + 90 s. |
| **Present** | An executor's state while its last heartbeat is at most 30 s old, its `drain` and `quarantine` flags are clear and its posture tier is not `unmanaged`. Only a present executor takes new claims. |
| **Slot** | A unit of executor capacity that holds one job. A device's slot ledger counts claim slots per class and capacity-lease slots per pool against the device total; a Container pool's slots come from its admission cap. |
| **Slot ledger** | The agent's persisted per-device count of claim slots per class and capacity-lease slots per pool, reconciled against the running VMs at start and reported as `in_use` on every heartbeat. |
| **Posture tier** | An executor's device posture read from MDM: `attested-dedicated`, `managed-workstation` or `unmanaged`. A `cloudflare` executor is `attested-dedicated`; an `unmanaged` executor gets no claim slots and no capacity lease. |
| **Device** | An owned machine running the `flare-dispatchd` agent. |
| **Device key** | The non-exportable P-256 key in a device's Secure Enclave, held by the Swift helper, that signs SHA-256 digests under one purpose tag: `connect`, `lease-call`, `statement` or `cache-entry`. |
| **Agent** | `flare-dispatchd`, the process on a device that holds the device key, connects to the control plane and launches one VM per job. |
| **Runner** | The FlareDispatch process on an executor that runs one execution's run program on the SQLite engine with the executor kind's capability Layers. On a device it runs under the agent's user, outside the job VM; on `cloudflare`, `aws` and `gha` it runs inside the job sandbox. Not a GitHub Actions runner. |
| **Job sandbox** | The isolation unit where repository commands run for one execution at one epoch: a VM per job on a device, the Container on `cloudflare`, the Fargate task on `aws`, the hosted runner VM on `gha`. It holds no credential; the egress proxy attaches per-lease credentials. |
| **Job** | The work one executor does for one execution at one epoch, from accepting the execution lease to teardown. In a job matrix, each job is a child execution of the matrix parent. |
| **Workspace** | The writable checkout of the execution's commit that a job's commands run in, created per execution and epoch and destroyed at teardown. On a device it is an APFS copy-on-write clone attached to the job VM as a block device. |
| **Fleet** | All executors registered with one control plane. |
| **Spill** | Placement on a cloud executor because no device slot can meet the deadline. |
| **Run** | A named, typed program written with `defineRun`. |
| **Recipe** | A run that ships in the catalog (`runs/gate.md`, `runs/agentic.md`). |
| **Job matrix** | The primitive that runs one parent execution as 1 to 64 jobs, each a child execution with its own placement, execution lease, hold and workspace, started within a window, ordered by `needs`, and aggregated into one verdict. |
| **Repo manifest** | A file in a consumer repository that names recipes and their parameters for that repository. |
| **Trigger** | The event that requests a run: webhook, Actions dispatch, cron, local submit or MCP call. |
| **Shed row** | A D1 row recording a trigger that intake rejected, coalesced or dropped, with class, repository, run, reason and estimated cost in micro-USD. |
| **Dedup key** | The canonical string naming what an execution verifies (for example `<run>[:<label>]:<owner>/<repo>:<sha>`), stored as its lowercase hex SHA-256 under a `UNIQUE` constraint, so that at most one execution exists per key. |
| **Execution** | One attempt to produce a verdict for one run on one commit. A reclaim keeps the execution and increments its epoch. |
| **Execution workflow** | The control plane's `effect/workflow` program, one per admitted P0–P2 execution (P3 from claim or `stale_at`). It runs on the DO-SQLite engine with the execution id as workflow id, and drives the stages from reservation to settle. |
| **Stage** | One named step of the `Execution` workflow, run in the order `reserve`, `place`, `lease`, `await-result`, `apply-outbox`, `settle`. |
| **Execution DO** | The Durable Object, one per execution id, whose SQLite storage holds that execution's `Execution` workflow journal and whose alarm wakes its `DurableClock` waits. |
| **Step** | One journaled unit inside an execution (`Activity` in the engine). |
| **Engine** | The `WorkflowEngine` implementation that journals steps. |
| **Backend** | One storage implementation of the engine or a store: DO-SQLite, SQLite, Postgres or memory. |
| **Journal** | The engine's durable record of an execution's completed steps. |
| **Class** | The QoS class of an execution, set once at intake by `resolveClass`: `P0` `release`, `P1` `required`, `P2` `interactive`, `P3` `batch`. Distinct from a local class (local-scheduler.md). |
| **Required check** | A check whose name is in the target branch's ruleset or branch-protection required set, read through the 10 min required-set cache. Its run resolves to P1, subject to its ceiling. |
| **Ops run** | A control-plane run that is not a catalog recipe (the canaries and the verdict audit), admitted against the P1 line and charged to the ops reserve `R_ops`. |
| **Local class** | The local scheduler's queue class for capacity-lease work, in strict precedence `dev-loop`, `swarm`, `rehearsal`, `background`. All rank below P3 and are not QoS classes. |
| **Claim deadline** | How long a P1 or P2 execution waits for a device claim before its cloud entry joins the queue: 60 s for P1, 300 s for P2, 0 s on a predicted miss. Stored as `cloud_eligible_at`. P0 has none; P3 uses its staleness point. |
| **Predicted miss** | The condition, evaluated at intake, that no present eligible device has a free claim slot for the class, or that the predicted local wait exceeds the class's claim deadline. It sets `cloud_eligible_at` to the intake time. |
| **Staleness point** | A P3 execution's `stale_at`: intake time plus half its schedule period, or plus 12 h for a run without a schedule. When it passes, the cloud entry of a P3 with an eligible cloud kind joins the queue. |
| **deadline_at** | The one absolute deadline of an execution, set at intake to intake time + queue age + serial bound + lease wait + `limits.maxDurationSec` + settle margin. Every executor stops the job by it, and passing it concludes `failure(deadline)`. |
| **Local deadline** | The agent's monotonic-clock instant for a lease: its time when it sent the `exec.claim` that produced the lease, plus `deadline_at` − `server_now`. It falls at or before `deadline_at`. |
| **Supersession** | The cancellation of every lower-ranked non-terminal member of a supersession group (repository, pull request, run, label) when a newer execution joins it, concluding each `cancelled(superseded)`. |
| **Serial group** | The executions of a run that declares `serialize`, sharing one group key. At most one holds the group at a time; a newer waiter concludes every older waiter `cancelled(superseded)`. |
| **Placement** | The control plane's choice of executor for an execution, stored as one row. |
| **Placement constraint** | A rule that removes executors from the eligible set (trigger, class, confidentiality mode). |
| **Claim** | A compare-and-set of a placement row from `queued` to `leased` that issues an execution lease. A device makes one through `exec.claim`; cloud admission makes one through the claim batch. |
| **Claim batch** | The one D1 batch that admits an execution to a cloud executor ([qos-admission.md](qos-admission.md) FD-QOS-038). Its first statement is a conditional `INSERT` of the reservation that checks the control state, the class line, the family allowance, the burn lane and the pool and browser-session slots; every later statement is guarded in SQL on that reservation, so the batch records the hold and the placement epoch together or changes nothing. |
| **Execution lease** | The right to run one execution, granted to one executor for one epoch, renewed by heartbeat. |
| **Capacity lease** | The right for a device to run unguaranteed local work in a set of slots for a bounded time. |
| **Epoch** | A counter on an execution. A reclaim increments it; the control plane accepts a result only for the current epoch. |
| **Reclaim** | The control plane ends an execution lease whose heartbeat stopped and places the execution again. |
| **Hold** | The amount an admission sets aside for an execution: its worst-case cost. |
| **Reservation** | A hold that is admitted and not yet settled or released. |
| **Settle** | Replace a reservation with the metered cost of the finished execution, in the settle batch ([spend.md](spend.md) FD-SPD-004). |
| **Line** | The spend level at which a class stops admitting. Lines nest: P3 ≤ P2 ≤ P1 ≤ P0 = budget. |
| **Burn lane** | The cap on the summed hourly list rate of admitted executions of one class and every lower class, across pools (FD-SPD-046). |
| **Allowance** | The model-call spend an execution may use, part of its hold. |
| **Halt** | An operator control that stops admission for a scope. |
| **Control state** | The one `qos_control` row in D1, with value `run`, `halt-cloud` or `halt-all`, that the claim batch reads on every admission. |
| **Verdict** | The `RunResult` of an execution: `success`, `failure(reason)`, `cancelled(cause)` or `skipped(not-applicable: <detail>)`. |
| **Failure reason** | The reason of a `failure` verdict, written `<kind>[: <detail>]`. Each kind belongs to one category of the closed union in run-model.md, and `checkConclusion` matches on the category. |
| **Cancel cause** | The cause of a `cancelled` verdict, from the closed set `superseded`, `pr-closed`, `merge-group-destroyed`, `parent-ended` and `operator-cancel` in run-model.md. |
| **Not-applicable detail** | The detail of a `skipped` verdict, from the closed set in run-model.md. Only a skip with a listed detail concludes `neutral`. |
| **Conclusion** | The GitHub check-run conclusion derived from a verdict. |
| **Check family** | All attempts of one run's check on one commit. They share a check name; each re-run is a new execution with dedup suffix `:attempt-<n>`. |
| **Intent** | A side effect a run requests, of a kind from run-model.md (`check.summary`, `comment`, `pr.propose`, `release.publish`, `dispatch.followOn` and others), keyed by `intent_key`. |
| **Intent key** | The key of an intent in the outbox: `run:` followed by the run's `<step name>:<index>` key for a run-authored intent, and `cp:<purpose>[:<qualifier>]` for an intent the control plane generates, such as `cp:writeback:<branch>` for `pr.propose`. It is unique per execution. |
| **Outbox** | The control-plane table that applies each intent once per `(execution_id, intent_key)`. |
| **Agent outbox** | The agent's on-device store of `exec.intents` batches and `exec.result` frames that are not yet acknowledged, replayed in write order after each `session.welcome`. Distinct from the outbox in D1. |
| **InstallationQuota** | The Durable Object, one per GitHub App installation, that holds the installation token, the rate-limit ledger and the permit queue, and runs the outbox drain for that installation. It is the only component that writes to GitHub. |
| **Staged write** | The file changes an execution proposes: a manifest (branch, base commit, message, pull-request fields, entries of path, mode and blob digest) plus blobs in the artifact store. It reaches GitHub only as a `pr.propose` intent after the staged-write gate accepts it. |
| **Staged-write gate** | The pure function `stagedWriteGate(manifest, writebackSpec, modelAuthored)` that the control plane runs on a result's staged write before recording any of its intents. It checks paths, the deny list, sensitive paths, the allowlist, sizes, modes, branch and the secret and URL scans. |
| **Confidentiality mode** | A repository setting: `unclassified`, `non-confidential`, `confidential-model` (no hosted model sees its data) or `confidential-compute` (its code runs only on owned devices). |
| **Task tier** | A model call's tier: `bulk` (classify, extract, summarize, embed) or `judgment` (review, plan, write code). |
| **Model gateway** | The control-plane route that is the one path from a run to a hosted model. It routes by confidentiality mode, task tier and location (`routeModelCall`), reserves each call against the allowance, holds every provider credential and writes model-call records. |
| **Egress profile** | The set of grants a job may use in one egress phase: `setup` or `agent`. |
| **Egress phase** | One of the two periods of an execution's egress, `setup` then `agent`, each with its own egress profile. The `setup` profile closes before the first agent-phase command and never reopens. |
| **Egress proxy** | The proxy that is a job sandbox's only outbound path on every executor kind. It admits an `https` request only when the request matches a grant in the current egress profile, attaches that grant's credential, and re-decides each redirect. |
| **Grant** | One entry of the grant catalog that a run declares for an egress phase: hosts, methods, paths, a body-size limit, a header allowlist and, optionally, the credential the egress proxy attaches. |
| **Grant catalog** | The committed set of named grants (for example `cf-api`, `github-api-read`) that run definitions reference by name. A reference to an absent grant fails the deploy check. |
| **Per-lease credential** | A credential the control plane issues for one execution lease, bound to the execution id and epoch, attached by the egress proxy, and revoked on reclaim, eviction or cancellation. |
| **Cache namespace** | A named partition of the cache (`protected/<repo>/cloud`, `protected/<repo>/device`, `pr/<repo>/<number>`, `exec/<repo>/<execution_id>`, `cas/<sha256>`) that the control plane assigns to an execution at placement as readable or writable. The executor takes it from its lease. |
| **Cache tier** | The writer class of a cache namespace: `protected-cloud`, `protected-device`, `pull-request`, `execution` or `content`. |
| **Protected trigger** | A push to the repository's default branch, or to a branch or tag that its ruleset or branch protection protects. It decides cache writes only: only an execution of a protected trigger may write a protected cache tier, and a `merge_group` event or a `gh-readonly-queue/*` push is not one. P0 eligibility follows its own trigger list ([qos-admission.md](qos-admission.md) FD-QOS-003). |
| **CacheLedger** | The Durable Object, one per repository, that reserves declared bytes before any cache or artifact upload and enforces the per-object, per-execution and per-repository byte bounds. |
| **Presigned URL** | An R2 URL that the control plane signs for one object key and one method, expiring at the earlier of 15 min and `deadline_at`. An executor moves cache, artifact and log bytes through it. |
| **Link token** | An HMAC capability token bound to one purpose and execution or artifact, with an expiry and a revocation epoch, that lets a holder read one log or artifact without an Access identity. |
| **Rehearsal** | A local run of a recipe that predicts its verdict without reporting to GitHub. |
| **Advisory result** | A verdict from capacity-lease work that posts no check and concludes nothing, unless a registered rehearsal stands in under the reuse rules. |
| **Provenance tier** | What a provenance statement proves: `device-signed`, `platform` or `reproduced`. |
| **Statement** | An in-toto Statement v1 in a DSSE envelope that names an output's subjects by digest and how they were built, carrying a lease binding (`execution_id`, `epoch`, `nonce`, `executor_id`, `binding_kind`). |
| **Provenance key** | The control plane's ES256 key, distinct from the OIDC, log and link keys, that countersigns accepted statements and signs cloud-builder statements and reproduction records. |
| **Countersignature** | The provenance key's signature that the control plane adds to an accepted statement's DSSE envelope before appending it to the transparency log. |
| **Cloud builder** | The control plane acting as builder of a statement for an execution whose current placement is a cloud executor and whose result arrived from that executor at the current epoch. The statement is signed with the provenance key. |
| **Operator overlay** | The deploying organization's values (ids, hostnames, budget) applied over the committed configuration. |

## Requirements

Each requirement is one sentence in EARS form, with the actor as subject and the condition first. `must` states a requirement, `must not` a prohibition and `may` a permission. A bound replaces every vague word: a number with a unit, a listed set or a named condition.

| Pattern | Form |
| --- | --- |
| Ubiquitous | The \<actor\> must \<response\>. |
| Event | When \<trigger\>, the \<actor\> must \<response\>. |
| State | While \<state\>, the \<actor\> must \<response\>. |
| Unwanted | If \<condition\>, then the \<actor\> must \<response\>. |
| Optional | Where \<feature\>, the \<actor\> must \<response\>. |

A requirement is written as a list item with its ID, phase and verification tags, then the sentence:

```text
- **FD-SPD-004** · phase 0 · `V-UNIT` `V-CONF` — When an execution settles, the control plane must replace its reservation with the metered cost in one D1 batch, the settle batch: a conditional `UPDATE reservations SET state = 'settled', actual_micro_usd = ?, settled_by = ? WHERE id = ? AND state IN ('held', 'unresolved')`, then `UPDATE spend_month SET settled_micro_usd = settled_micro_usd + ? WHERE month = ? AND EXISTS (SELECT 1 FROM reservations WHERE id = ? AND state = 'settled' AND settled_by = ?)`, where `settled_by` is the id of that settle attempt.
```

IDs have the form `FD-<AREA>-NNN`. Numbers are never reused; a removed requirement keeps its ID with the text `Removed.`, or with `Removed; see [file](file.md) FD-<AREA>-NNN[ and FD-<AREA>-NNN].` when another file's requirement states the same behaviour. Areas:

| Area | File | Area | File |
| --- | --- | --- | --- |
| `ARCH` | architecture.md | `ISO` | isolation-egress.md |
| `RUN` | run-model.md | `CACHE` | cache-artifacts.md |
| `ENG` | engine.md | `GH` | github-output.md |
| `INT` | intake.md | `MDL` | model-gateway.md |
| `QOS` | qos-admission.md | `LOCAL` | local-scheduler.md |
| `SPD` | spend.md | `IFC` | interfaces.md |
| `LEASE` | placement-leases.md | `PROV` | provenance.md |
| `PROTO` | executor-protocol.md | `OPS` | operability.md |
| `EXEC` | executors.md | `GATE` | runs/gate.md |
| `VER` | verification.md | `AGT` | runs/agentic.md |

An open question stays in place as `TODO(<owner>): <question>`, where the owner is a role (`operator`, `maintainer`).

## Verification tags

Every `must` and `must not` carries at least one tag. [verification.md](verification.md) maps each ID to its harness and phase gate.

| Tag | Method |
| --- | --- |
| `V-UNIT` | `@effect/vitest` with test Layers: memory engine, fake GitHub, fake executor |
| `V-CONF` | One conformance suite run against every backend of an interface |
| `V-SIM` | Deterministic simulation of the fleet with `TestClock` and fault injection |
| `V-REPLAY` | Every workflow runs twice over a cached journal; extra GitHub calls, D1 writes or intents fail it |
| `V-E2E-LOCAL` | The full stack on one machine: workerd, a local agent, a recorded GitHub fixture server, a local VM |
| `V-DEPLOY` | `wrangler deploy --dry-run` and the overlay drift check in CI |
| `V-LIVE` | A synthetic webhook canary, an installation probe and `pr-review` on this repository's pull requests |
| `V-MEASURE` | A metric from the executions table with a threshold that a phase gate reads |
| `V-PROOF` | A Lean 4 theorem in `formal/`, or a Tamarin lemma for provenance, named by requirement ID |
| `V-DIFF` | Differential random testing of a TypeScript kernel against the compiled Lean oracle |

## File format

A spec file starts with a `# Title` and one paragraph that says what the file specifies; the site uses that paragraph as the page description. Then, in order:

1. **Scope**: what the file covers and the files it depends on.
2. **Model**: the entities, states and diagrams.
3. **Requirements**: grouped by topic, in the format above.
4. **Open items**: the `TODO(<owner>)` lines.

An ADR is `adr/NNNN-<slug>.md` with the sections Status and date, Context, Decision, Options considered, Criteria, Consequences and Revisit triggers ([adr/README.md](adr/README.md)).

## Diagrams

Diagrams are `mermaid` code blocks rendered to SVG at build time by Merlion. Merlion renders `flowchart`, `sequenceDiagram` and `stateDiagram-v2`; any other diagram type fails the site build. Each diagram:

- shows a mechanism the prose would otherwise make the reader assemble;
- holds one kind of thing per node (a component, a store, an actor or an action);
- uses subgraphs for trust zones and ownership;
- starts with an `accTitle:` line and is followed by an italic caption line;
- uses Merlion's roles for meaning, not decoration: `accent` for an entry point, `store` for a database or bucket, `warn` for a decision, `danger` for a refusal or failure state, `ok` for a terminal success, `muted` for a component outside the system, `group` for a zone, `failure` and `async` for edges.

`node apps/docs/scripts/check-diagrams.mjs specs/**/*.md` renders every diagram and fails on an unsupported type or a parse error.
