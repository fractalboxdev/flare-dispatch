# FlareDispatch specifications

FlareDispatch is CI/CD that an organization deploys into its own Cloudflare account. It is an application on mameko: it composes mameko's coordinator with the `host-cloudflare` runtime adapter, its CI profile and its GitHub appliers. Cloudflare is the control plane: it receives triggers, classifies and meters work, leases it to an executor and reports the verdict to GitHub. Execution runs first on hardware the organization owns, and moves to Cloudflare Containers and then to outside launchers when owned capacity cannot meet a deadline. These files specify what FlareDispatch decides as a CI application; mameko's specifications specify the mechanism it composes. The [ADRs](adr/README.md) record why it has this shape.

## Depends on mameko

FlareDispatch depends on mameko at commit `3af65c59d5f30123eb55b468966b4975c7395ece`. Every citation of mameko names that commit in full, so a mameko renumbering never changes what a citation means:

- a requirement: `[MAMEKO-<AREA>-NNN](https://github.com/fractalboxdev/mameko/blob/3af65c59d5f30123eb55b468966b4975c7395ece/specs/<file>.md)`;
- a section: the same link with the heading's anchor, written `mameko <file> § <heading>`;
- an ADR: `https://github.com/fractalboxdev/mameko/blob/3af65c59d5f30123eb55b468966b4975c7395ece/specs/adr/<file>.md`.

Moving the pin is one change that updates every link, rechecks each cited ID against `specs/ids.renames.tsv` at the new commit and passes the `spec-tags` check ([verification.md](verification.md) FD-VER-035, FD-VER-036).

## Index

| File | Specifies | Phase |
| --- | --- | --- |
| [architecture.md](architecture.md) | The Cloudflare deployment, trigger kinds, GitHub credentials and byte routes around mameko's coordinator | 0–4 |
| [profile.md](profile.md) | FlareDispatch's application profile: classes, `resolveClass`, dedup recipes, pools, placement constraints, outcome mapping, intent kinds, delivery, spend values | 0–4 |
| [run-model.md](run-model.md) | What FlareDispatch adds to mameko's run model: trigger events, `GithubRead`, the outcome mapping, `signals/v1` | 0 |
| [intake.md](intake.md) | Triggers, signatures, repo manifests, dedup key forms and the answers each trigger receives | 0–3 |
| [spend.md](spend.md) | FlareDispatch's use of mameko's spend meter: the rate card, the budget and the check re-run line | 0 |
| [executor-protocol.md](executor-protocol.md) | The `gha` runner's socket authentication, as the launcher port's `verify` | 4 |
| [executors.md](executors.md) | The GitHub Actions launcher and FlareDispatch's values for the `cloudflare`, `device` and `aws` kinds | 1–4 |
| [isolation-egress.md](isolation-egress.md) | Egress rules for the `gha` launcher kind | 4 |
| [cache-artifacts.md](cache-artifacts.md) | Two-level cache, trust namespaces, cache keys, the object-store presigner, artifacts, retention | 0–2 |
| [github-output.md](github-output.md) | Check-run lifecycle intents, conclusion mapping, GitHub appliers, the installation quota, merge queue, side outputs | 0–2 |
| [model-gateway.md](model-gateway.md) | The `workers-ai` and `bedrock` route kinds and their pricing | 0 |
| [local-scheduler.md](local-scheduler.md) | FlareDispatch's local registration port, reuse policy and writeback gate | 1–2 |
| [interfaces.md](interfaces.md) | HTTP API, `fd` CLI, MCP tools | 0–4 |
| [provenance.md](provenance.md) | Statements, provenance tiers, the attestation verifier, the result-acceptance check, transparency log, verification policy | 0–4 |
| [operability.md](operability.md) | BYOC deploy, operator overlay, drift check, GitHub probes, the alarm port, dashboard, operator routes | 0–3 |
| [runs/gate.md](runs/gate.md) | Gate and test recipes, the job-matrix primitive, exit-to-conclusion rules | 0–2 |
| [runs/agentic.md](runs/agentic.md) | Agentic recipes, staged writeback, path allowlist, secret scan, trifecta rule | 0–4 |
| [verification.md](verification.md) | Requirement → method → harness → phase gate; mameko conformance on the composed host; FlareDispatch's formal properties | — |
| [roadmap.md](roadmap.md) | Phases 0–4, the mameko phase each waits on, gates, kill criteria, requirements each phase closes | — |

## Glossary

Each term has one meaning in every file. A file that needs a new term adds it here. Terms of mameko's mechanism keep mameko's meaning and are defined in [mameko's glossary](https://github.com/fractalboxdev/mameko/blob/3af65c59d5f30123eb55b468966b4975c7395ece/specs/README.md#glossary) and its term index: application, control plane, coordinator, port, profile, tenant scope, executor, executor kind, device, device executor, device key, key helper, device extension, runner, job sandbox, job, workspace, run, request, execution, stage, class, placement, claim, execution lease, capacity lease, epoch, reclaim, hold, reservation, settle, line, burn lane, allowance, halt, control state, outcome, failure reason, cancel cause, intent, intent key, effect class, outbox, drainer, applier, applier rate limit, lifecycle intent, ops intent, ops run, dedup key, shed row, supersession, serial group, placement constraint, claim deadline, predicted miss, `deadline_at`, local class, confidentiality mode, model gateway, egress profile, egress phase, egress proxy, grant, grant catalogue and per-lease credential.

| Term | Meaning |
| --- | --- |
| **mameko** | The libraries FlareDispatch composes: the coordinator, the runtime adapters, the device bundle and the protocol, cited at the pinned commit of § Depends on mameko. |
| **Composed control plane** | mameko's coordinator on `host-cloudflare` with FlareDispatch's profile, appliers and application ports, as one Cloudflare deployment. |
| **Executor kind `gha`** | FlareDispatch's launcher kind: a GitHub Actions job that runs one runner under one execution lease ([executors.md](executors.md)). |
| **Class names** | FlareDispatch's four classes, in rank order: `release` (P0), `required` (P1), `interactive` (P2) and `batch` (P3) ([profile.md](profile.md) § Class catalogue). |
| **Required check** | A check whose name is in the target branch's ruleset or branch-protection required set, read through the 10 min required-set cache. Its run resolves to `required`, subject to its ceiling. |
| **Trigger** | The event that requests a run: webhook, Actions dispatch, cron, local submit or MCP call. |
| **Repo manifest** | A file in a consumer repository that names recipes and their parameters for that repository. |
| **Recipe** | A run that ships in the catalog (`runs/gate.md`, `runs/agentic.md`). |
| **Job matrix** | The primitive that runs one parent execution as 1 to 64 jobs, each a child execution with its own placement, execution lease, hold and workspace, started within a window, ordered by `needs`, and aggregated into one verdict. |
| **Verdict** | An execution's outcome as FlareDispatch reports it: `success`, `failure(reason)`, `cancelled(cause)` or `skipped(not-applicable: <detail>)`. |
| **Not-applicable detail** | The detail of a `skipped` verdict, from the closed set the profile lists. Only a skip with a listed detail concludes `neutral`. |
| **Conclusion** | The GitHub check-run conclusion `checkConclusion` derives from a verdict. |
| **Check family** | All attempts of one run's check on one commit. They share a check name; each re-run is a new execution with dedup suffix `:attempt-<n>`. This number counts executions of the family; the `attempt` of a run payload counts earlier leases of one execution. |
| **InstallationQuota** | The Durable Object, one per GitHub App installation, that implements mameko's applier rate limit for that installation: it records each response's rate-limit headers and grants or defers one permit per applier call. |
| **Staged write** | The file changes an execution proposes: a manifest (branch, base commit, message, pull-request fields, entries of path, mode and blob digest) plus blobs in the artifact store. It reaches GitHub only through the `pr.propose` applier after the staged-write gate accepts it. |
| **Staged-write gate** | The pure function `stagedWriteGate(manifest, writebackSpec, modelAuthored)` that the `pr.propose` applier runs before any GitHub call. It checks paths, the deny list, sensitive paths, the allowlist, sizes, modes, branch and the secret and URL scans. |
| **Cache namespace** | A named partition of the cache (`protected/<repo>/cloud`, `protected/<repo>/device`, `pr/<repo>/<number>`, `exec/<repo>/<execution_id>`, `cas/<sha256>`) that the profile's `cache_namespaces` binding gives an execution at each lease grant as readable or writable. The executor takes it from its lease. |
| **Cache tier** | The writer class of a cache namespace: `protected-cloud`, `protected-device`, `pull-request`, `execution` or `content`. |
| **Protected trigger** | A push to the repository's default branch, or to a branch or tag that its ruleset or branch protection protects. It decides cache writes only: only an execution of a protected trigger may write a protected cache tier, and a `merge_group` event or a `gh-readonly-queue/*` push is not one. |
| **CacheLedger** | The Durable Object, one per repository, that reserves declared bytes before any cache or artifact upload and enforces the per-object, per-execution and per-repository byte bounds. |
| **Object-store presigner** | FlareDispatch's implementation of mameko's object-store presigner port: it signs each R2 URL for one object key and one method, expiring at the earlier of 15 min and `deadline_at`. |
| **Link token** | An HMAC capability token bound to one purpose and execution or artifact, with an expiry and a revocation epoch, that lets a holder read one log or artifact without an Access identity. |
| **Rehearsal** | A local run of a recipe that predicts its verdict without reporting to GitHub. |
| **Advisory result** | A verdict from capacity-lease work that posts no check and concludes nothing, unless FlareDispatch's reuse policy lets a registered rehearsal stand in. |
| **Provenance tier** | What a provenance statement proves: `device-signed`, `platform` or `reproduced`. |
| **Statement** | An in-toto Statement v1 in a DSSE envelope that names an output's subjects by digest and how they were built, carrying a lease binding (`execution_id`, `epoch`, `nonce`, `executor_id`, `binding_kind`). |
| **Statement builder** | FlareDispatch's device-extension operation that writes a device statement from the lease, the outcome and the output digests the device executor passes it. |
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
- **FD-GH-017** · phase 0 · `V-UNIT` — If a check run's summary or text exceeds 65535 characters, then the control plane must cut it to 65535 characters including a final truncation line that links the log viewer.
```

IDs have the form `FD-<AREA>-NNN`. Numbers are stable: a surviving requirement keeps its ID when it is rewritten, and a number is never reused. A requirement whose behaviour another file or mameko states is removed from its file and listed in `specs/ids.moved.tsv`, one row per ID with the columns `fd_id`, `disposition` and `target`: `moved` with the MAMEKO ID or IDs that state it, `profile` with the [profile.md](profile.md) ID that holds its value, `merged` with the FD ID or IDs in another file that state it, or `removed` with the reason it has no successor. The `spec-tags` check reads that table ([verification.md](verification.md) FD-VER-006 to FD-VER-008, FD-VER-034 to FD-VER-037). Areas:

| Area | File | Area | File |
| --- | --- | --- | --- |
| `ARCH` | architecture.md | `ISO` | isolation-egress.md |
| `PROF` | profile.md | `CACHE` | cache-artifacts.md |
| `RUN` | run-model.md | `GH` | github-output.md |
| `INT` | intake.md | `MDL` | model-gateway.md |
| `SPD` | spend.md | `LOCAL` | local-scheduler.md |
| `PROTO` | executor-protocol.md | `IFC` | interfaces.md |
| `EXEC` | executors.md | `PROV` | provenance.md |
| `VER` | verification.md | `OPS` | operability.md |
| `GATE` | runs/gate.md | `AGT` | runs/agentic.md |

An open question stays in place as `TODO(<owner>): <question>`, where the owner is a role (`operator`, `maintainer`).

## Verification tags

Every `must` and `must not` carries at least one tag. [verification.md](verification.md) maps each ID to its harness and phase gate.

| Tag | Method |
| --- | --- |
| `V-UNIT` | `@effect/vitest` with test Layers: mameko's memory runtime adapter, fake GitHub, fake executor |
| `V-CONF` | One conformance suite run against every backend of an interface, mameko's coordinator suite on the composed control plane included |
| `V-SIM` | Deterministic simulation of the fleet with `TestClock` and fault injection |
| `V-REPLAY` | Every workflow runs twice over a cached journal; extra GitHub calls, D1 writes or intents fail it |
| `V-E2E-LOCAL` | The full stack on one machine: workerd, a device executor from mameko's device bundle, a recorded GitHub fixture server, a local job sandbox |
| `V-DEPLOY` | `wrangler deploy --dry-run`, mameko's profile validator, the reference-profile diff and the overlay drift check in CI |
| `V-LIVE` | A synthetic webhook canary, an installation probe and `pr-review` on this repository's pull requests |
| `V-MEASURE` | A metric from the executions table with a threshold that a phase gate reads |
| `V-PROOF` | A Lean 4 theorem in `formal/`, or a Tamarin lemma for provenance, named by requirement ID |
| `V-DIFF` | Differential random testing of `stagedWriteGate` against the compiled Lean oracle |

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
