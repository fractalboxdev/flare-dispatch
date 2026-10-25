# Operability

This file specifies how an organization deploys FlareDispatch into its own Cloudflare account and keeps it running: the values-only operator overlay, the deploy-time drift check, CI on every pull request, liveness probes and alerts, the dashboard behind Cloudflare Access, the operator controls and the runbook.

## Scope

This file covers the deploy path from a commit to running Workers, the checks that keep the deployed configuration equal to the committed one, the signals that show the control plane is alive, and the controls and procedures an operator uses. It depends on:

- [architecture.md](architecture.md) for the Workers, Durable Objects, D1 database and R2 buckets that make up the control plane;
- [spend.md](spend.md) for the meaning of `run`, `halt-cloud` and `halt-all`, the ops reserve, budget top-ups and `unresolved` charges;
- [qos-admission.md](qos-admission.md) for the placement policy validator, force-admit and the `deferred` state;
- [placement-leases.md](placement-leases.md) for drain, epochs and lease credentials;
- [github-output.md](github-output.md) for the outbox, the delivery sweep, the settle sweep and the App's permission set;
- [executors.md](executors.md) for the image digest each executor kind runs and the device health probe;
- [interfaces.md](interfaces.md) for the HTTP API, the identity gate of each surface and the `fd` CLI that hosts `fd deploy`, `fd doctor` and `fd ops`;
- [runs/gate.md](runs/gate.md) for the `check` recipe that runs this repository's CI.

[ADR-0012](adr/0012-values-only-overlay.md) records why the overlay holds values only.

Not specified: a per-environment deploy console with approval.

## Model

### Template, overlay and rendered configuration

Each Worker has one committed template (`wrangler.jsonc`). The template holds the whole topology: bindings, Durable Object classes and migrations, cron schedules, container classes and images, compatibility settings, limits and rollout settings. Every account-specific value in a template is a placeholder.

The operator overlay is a JSON document of values only. The value schema, a `Schema.Struct` in the deploy CLI, declares every value path. Decoding uses `Schema.decodeUnknownEffect` with `onExcessProperty: "error"`, so an undeclared key fails the decode.

| Value path | Holds |
| --- | --- |
| `accountId` | Cloudflare account id |
| `d1.<binding>` | D1 database id per binding |
| `kv.<binding>` | KV namespace id per binding |
| `r2.<binding>` | R2 bucket name per binding |
| `hostnames.<worker>` | Custom-domain hostname per Worker |
| `access.teamDomain`, `access.aud` | Cloudflare Access team domain and application AUD |
| `operators` | Access identities allowed on operator routes |
| `dispatchers` | Access identities allowed to dispatch through `fd` and `/mcp` ([interfaces.md](interfaces.md) FD-IFC-027) |
| `github.appId`, `github.fixtureRepo` | GitHub App id; the repository the synthetic webhook canary pushes to |
| `intake.webhookEvents` | The webhook events intake admits ([intake.md](intake.md) FD-INT-027) |
| `dispatch.oidcAudience` | The Actions OIDC audience of a dispatch ([interfaces.md](interfaces.md) FD-IFC-024) |
| `executors.clientCa` | The certificate authority that signs agents' client certificates ([executor-protocol.md](executor-protocol.md)) |
| `alerts.sink` | An HTTPS webhook URL or an email address |
| `alerts.webhookSilentHours` | The delivery gap that raises `webhook-silent`, default 24 |
| `spend.*` | The budget and reserve settings [spend.md](spend.md) defines |
| `pools.<pool>.maxInstances` | Container `max_instances` per pool, bounded by the account's limits |
| `aws.budgetUsd`, `aws.launchCap`, `aws.egressProxy`, `aws.imageRegistry` | The AWS limit, launch cap, egress proxy endpoint and image registry endpoint ([executors.md](executors.md) FD-EXEC-083, [isolation-egress.md](isolation-egress.md) FD-ISO-020) |
| `gha.concurrencyCap`, `gha.runnerRepo`, `gha.workflow` | The GitHub Actions launcher's concurrency cap, runner repository and runner workflow ([executors.md](executors.md) FD-EXEC-085, FD-EXEC-089) |
| `egress.targetPatterns` | Dynamic egress target patterns ([isolation-egress.md](isolation-egress.md) FD-ISO-041) |
| `models.registry`, `models.fallbackPriceUsdPerMTok`, `models.bucketShares`, `models.breaker` | The provider registry, fallback price, per-class bucket shares and breaker threshold ([model-gateway.md](model-gateway.md) FD-MDL-019, FD-MDL-021, FD-MDL-045, FD-MDL-049) |
| `provenance.attestationMaxAgeDays`, `provenance.reattestIntervalDays`, `provenance.auditRate`, `provenance.statementRetentionDays`, `provenance.witnesses` | `attestation_max_age`, `reattest_interval`, `audit_rate`, the statement retention and the private log's witnesses ([provenance.md](provenance.md) FD-PROV-016, FD-PROV-030, FD-PROV-069, FD-PROV-075, FD-PROV-039) |

```json
{
  "accountId": "<account id>",
  "d1": { "CONTROL_DB": "<database id>" },
  "r2": { "CACHE": "<bucket name>", "ARTIFACTS": "<bucket name>" },
  "hostnames": { "dispatcher": "<hostname>", "docs": "<hostname>" },
  "access": { "teamDomain": "<team domain>", "aud": "<aud tag>" },
  "operators": ["<access identity>"],
  "github": { "appId": "<app id>", "fixtureRepo": "<owner>/<repo>" },
  "alerts": { "sink": "<https url or email>" },
  "spend": { "budgetUsd": "<budget USD>" },
  "pools": { "lean": { "maxInstances": "<count>" } }
}
```

No overlay value is a secret. Secrets, the webhook secret included ([intake.md](intake.md) FD-INT-022), are Worker secrets set with `wrangler secret put` (runbook R14), and the drift check shows each by name only. The renderer replaces each placeholder with its value and changes nothing else. The drift check then compares the rendered configuration with three references: the template's own invariants, the live deployed Worker, and the GitHub App registration.

```mermaid
flowchart LR
  accTitle: The renderer fills placeholders from the overlay and the drift check gates the deploy
  subgraph git[Repository]
    tpl[(Template per Worker)]
    reg[(Sweep list)]
    appman[(App manifest)]
  end
  subgraph op[Operator]
    ovl[(Operator overlay)]
  end
  subgraph cli[fd deploy]
    dec{Decode overlay against value schema}
    render[Renderer]
    drift{Drift check}
    deploy[wrangler deploy per Worker]
  end
  subgraph cf[Cloudflare account]
    live[(Deployed Worker settings)]
    rec[(Rendered config of last deploy)]
  end
  gh[GitHub App registration]
  ovl --> dec
  dec e1@-->|undeclared or missing value| rej[Reject before any change]
  dec -->|values| render
  tpl -->|topology and placeholders| render
  render -->|rendered config| drift
  reg -->|expected sweep schedules| drift
  appman -->|expected permissions and events| drift
  live -->|bindings, vars, crons, routes| drift
  rec -->|what the last deploy set| drift
  gh -->|permissions and events| drift
  drift e2@-->|any difference| fail[Fail with path, deployed and rendered value]
  drift -->|clean| deploy
  deploy -->|records| rec
  class dec accent
  class drift warn
  class tpl store
  class reg store
  class appman store
  class ovl store
  class live store
  class rec store
  class gh muted
  class rej danger
  class fail danger
  class deploy ok
  class git group
  class op group
  class cli group
  class cf group
  class e1 failure
  class e2 failure
```

*overlay render · values fill placeholders; any drift stops the deploy before a change.*

### Deploy pipeline

```mermaid
sequenceDiagram
  accTitle: From a pull request to deployed and probed Workers
  participant DEV as Pull request
  box rgba(156,163,175,0.15) GitHub
    participant GHA as Actions workflows
  end
  box rgba(37,99,235,0.15) Control plane
    participant FD as FlareDispatch check
  end
  participant CLI as fd deploy
  box rgba(22,163,74,0.15) Cloudflare account
    participant API as Cloudflare API
    participant W as Workers
  end
  DEV->>FD: pull_request opened or synchronize
  FD-->>DEV: flare-dispatch/check:ci, required
  DEV->>GHA: pull_request
  GHA-->>DEV: fallback CI check, not required
  DEV->>GHA: merge, push to default branch
  GHA->>GHA: CI commands must pass
  GHA->>CLI: run with overlay from one repository secret
  CLI->>CLI: decode overlay, render
  CLI->>API: read deployed settings and last rendered config
  alt drift found
    CLI-->>GHA: fail, no state changed
  else clean
    CLI->>API: apply D1 migrations
    CLI->>W: deploy Workers, bound services first
    CLI->>W: GET /health, container canary on deployed digest
    alt probe fails
      CLI-->>GHA: non-zero exit, page deploy-probe-failed, print rollback command
    else probes pass
      CLI->>API: record rendered config
      CLI-->>GHA: success
    end
  end
```

*deploy pipeline · CI on every pull request, drift check before migrations, probes after deploy.*

### Liveness and alerts

Three probes run every 15 min from the control plane's cron: the synthetic webhook canary, the installation probe and the delivery probe. The canary pushes a real commit, so the webhook crosses public DNS, the GitHub App installation, the webhook signature, intake, placement and the outbox. The delivery probe reads GitHub's own record of failed deliveries, which reports a broken hostname even when no webhook reaches the control plane.

```mermaid
sequenceDiagram
  accTitle: The canary, installation probe and delivery probe feed one alert path
  box rgba(37,99,235,0.15) Control plane
    participant CRON as Cron, every 15 min
    participant IN as Intake
    participant AL as Alert path
  end
  box rgba(156,163,175,0.15) GitHub
    participant API as GitHub API
    participant FIX as Fixture repository
  end
  participant SINK as Alert sink
  CRON->>API: outbox: push empty commit to canary branch
  API->>FIX: update canary branch
  FIX-->>IN: webhook over public hostname
  IN->>IN: canary run, control pool, rank P1, P1 line
  IN->>API: conclude canary check success
  CRON->>API: read canary check after 5 min
  alt no success conclusion
    CRON->>AL: page canary-missed, last stage reached
  end
  CRON->>API: GET /app/installations/{id} per installation
  alt 404 or suspended
    CRON->>AL: page installation-lost
  end
  CRON->>API: GET /app/hook/deliveries, last 15 min
  alt any non-2xx delivery
    CRON->>AL: page delivery-failing
    CRON->>API: one redelivery per failed delivery, App JWT
  end
  CRON->>AL: ok heartbeat with probe results
  AL->>SINK: alarms once per key per 24 h, and heartbeat
  Note over SINK: pages when no heartbeat arrives for 30 min
```

*liveness · real webhook path, GitHub's delivery record, and a heartbeat the sink watches.*

| Alarm | Severity | Fires when | Runbook |
| --- | --- | --- | --- |
| `canary-missed` | page | The canary check has no `success` conclusion 5 min after the push | R1 |
| `delivery-failing` | page | A webhook delivery in the last 15 min has a non-2xx status | R1 |
| `installation-lost` | page | An installation read returns 404 or suspended, or an `installation` event deletes or suspends one | R2 |
| `deploy-probe-failed` | page | A post-deploy probe fails | R4 |
| `floor-canary-failed` | page | A container or AWS canary stage fails | R5 |
| `placement-stalled` | page | No placement row for 30 min while executions are queued and executor heartbeats arrive | R6 |
| `drift` | notify | The daily drift check finds a difference | R3 |
| `cron-silent` | notify | The minute tick's last recorded time is older than 2 min | R7 |
| `webhook-silent` | notify | An installation with an enrolled repository has had no verified delivery for `alerts.webhookSilentHours` | R1 |
| `executions-lost` | notify | The settle sweep ([github-output.md](github-output.md) FD-GH-072) ends one or more executions | R8 |
| `operator-control` | notify | The control state is not `run`, or a quarantine, force-admit or top-up is active | R9 |

Other files define their own alarms (spend, QoS, delivery); every alarm travels the same alert path.

### Operator control state

[spend.md](spend.md) defines what each control state admits; this diagram shows how an operator moves between them. Every transition writes an audit row.

```mermaid
stateDiagram-v2
  accTitle: Operator control state and its transitions
  [*] --> run
  run --> halt_cloud: fd ops halt halt-cloud
  run --> halt_all: fd ops halt halt-all
  halt_cloud --> halt_all: fd ops halt halt-all
  halt_all --> halt_cloud: fd ops halt halt-cloud
  halt_cloud --> run: fd ops halt run
  halt_all --> run: fd ops halt run
  state "halt-cloud" as halt_cloud
  state "halt-all" as halt_all
  note right of halt_all
    operator-control alarm repeats every 24 h
  end note
  class run ok
  class halt_cloud warn
  class halt_all danger
```

*control state · each change takes effect at the next claim and raises a daily alarm until `run`.*

### Runbook

| Entry | Trigger | First action | Relies on |
| --- | --- | --- | --- |
| R1 Webhooks not arriving | `canary-missed`, `delivery-failing`, `webhook-silent` | `fd doctor --live`; confirm the dispatcher hostname resolves and GitHub's delivery status; the delivery probe redelivers each failed delivery once the path works | FD-OPS-038, FD-OPS-040, FD-OPS-044, FD-OPS-045 |
| R2 Installation lost | `installation-lost` | Reinstall the GitHub App on the account, then `fd doctor` | FD-OPS-042, FD-OPS-043 |
| R3 Configuration drift | `drift`, a failed deploy | Read the paths `fd doctor` lists; move the change into the overlay or the template; deploy again | FD-OPS-016 to FD-OPS-023, [intake.md](intake.md) FD-INT-050 |
| R4 Post-deploy probe failed | `deploy-probe-failed` | Run the `wrangler rollback` command `fd deploy` printed; where it printed `fix forward: rollback blocked by migration <tag>`, fix forward on a new commit | FD-OPS-013 |
| R5 Floor canary failed | `floor-canary-failed` | Compare the failing digest with the last `sandbox-image` publish; rebuild the image | FD-OPS-047, FD-OPS-048 |
| R6 Placement stalled | `placement-stalled` | Open the fleet view; `fd ops drain <executor>` for an executor that heartbeats and claims nothing | FD-OPS-052 |
| R7 Cron silent | `cron-silent` | Compare the live cron trigger with the rendered configuration's single minute tick; deploy again | FD-OPS-037, [intake.md](intake.md) FD-INT-050 |
| R8 Lost executions | `executions-lost` | Read the swept executions in the executions view; the settle sweep has already concluded them | FD-OPS-063 |
| R9 Operator control active | `operator-control` | Confirm the control is intended, or `fd ops halt run` | FD-OPS-084 |
| R10 Device maintenance | Planned OS update or move | `fd ops drain <executor>`; wait for in-flight executions; release after the work | FD-OPS-077 |
| R11 Device key compromise | Lost or compromised device | `fd ops revoke <executor>`, then `fd ops quarantine <executor>` | FD-OPS-086, FD-OPS-087 |
| R12 Runaway cloud spend | Spend alarms | `fd ops halt halt-cloud` | FD-OPS-077 |
| R13 Control-plane outage | Every check pending | Run the GitHub Actions CI workflow on the pull request; apply a temporary ruleset change that accepts its check; revert the ruleset when the control plane serves again | FD-OPS-027, FD-OPS-029 |
| R14 Secret rotation | Scheduled or after exposure | `wrangler secret put` for each Worker that holds the secret, then `fd doctor` | FD-OPS-024 |

## Requirements

### Template and overlay

- **FD-OPS-001** · phase 0 · `V-DEPLOY` `V-UNIT` — The repository must commit one template configuration per Worker, and every account-specific value in a template must be a placeholder.
- **FD-OPS-002** · phase 0 · `V-UNIT` — The operator overlay must hold only values at the paths the value schema declares, and must not hold bindings, Durable Object classes, migrations, cron schedules, container class definitions, compatibility settings, limits or rollout settings.
- **FD-OPS-003** · phase 0 · `V-UNIT` `V-DEPLOY` — If the operator overlay contains a key the value schema does not declare, then `fd deploy` must reject the overlay, naming the key's path, before it changes any Cloudflare state.
- **FD-OPS-004** · phase 0 · `V-UNIT` `V-DEPLOY` — If the operator overlay lacks a value the value schema marks required, then `fd deploy` must reject the overlay, naming the path, before it changes any Cloudflare state.
- **FD-OPS-005** · phase 0 · `V-UNIT` — The renderer must produce each Worker's configuration by replacing each template placeholder with its overlay value, and must not replace, delete or merge any other part of the template.
- **FD-OPS-006** · phase 0 · `V-UNIT` — The renderer must be a pure function of the template and the overlay, so the same inputs render byte-identical configuration.
- **FD-OPS-007** · phase 0 · `V-DEPLOY` — Every deploy path (the deploy workflow, `fd deploy` on a workstation and the published deploy action) must render configuration through the one renderer.
- **FD-OPS-008** · phase 0 · `V-DEPLOY` — The deploy workflow must read the operator overlay from one repository secret, and if the secret is absent, then the workflow must fail before its first deploy step.
- **FD-OPS-009** · phase 0 · `V-DEPLOY` `V-UNIT` — When `fd deploy` runs, it must run overlay decode, render, drift check, D1 migrations, Worker deploys and post-deploy probes in that order, and stop at the first stage that fails.
- **FD-OPS-010** · phase 0 · `V-DEPLOY` — `fd deploy` must deploy a Worker only after it has deployed every Worker that the first Worker binds as a service.
- **FD-OPS-011** · phase 0 · `V-DEPLOY` — The deploy workflow must run at most one deploy per account at a time, and must not cancel a deploy that has started.
- **FD-OPS-012** · phase 0 · `V-DEPLOY` `V-UNIT` — Every template must set `keep_vars` to `false`.
- **FD-OPS-013** · phase 0 · `V-DEPLOY` `V-LIVE` — If a post-deploy probe fails, then `fd deploy` must exit with a non-zero status, raise the page alarm `deploy-probe-failed` and, for each Worker, print the `wrangler rollback` command for its previous version only when the deploy carried no Durable Object migration and no D1 migration, and otherwise print `fix forward: rollback blocked by migration <tag>`.
- **FD-OPS-014** · phase 0 · `V-DEPLOY` — `fd deploy` must not roll a Worker back without an operator running the rollback command.

### Drift check

- **FD-OPS-015** · phase 0 · `V-DEPLOY` — When `fd deploy` finishes deploying every Worker and passing every probe, it must store each Worker's rendered configuration in the artifacts bucket as the record of the last deploy.
- **FD-OPS-016** · phase 0 · `V-DEPLOY` — Before a deploy step changes Cloudflare state, the drift check must read each deployed Worker's bindings, vars, cron triggers, routes, compatibility settings and container classes through the Cloudflare API and compare them with the record of the last deploy.
- **FD-OPS-017** · phase 0 · `V-DEPLOY` — If a deployed setting differs from the record of the last deploy, then the drift check must fail, listing each path with its deployed and recorded values, and with each secret shown by name only.
- **FD-OPS-018** — Removed; see [intake.md](intake.md) FD-INT-050.
- **FD-OPS-019** · phase 0 · `V-DEPLOY` `V-UNIT` — If a binding that the control plane's environment schema declares is absent from a rendered configuration, then the drift check must fail, naming the binding.
- **FD-OPS-020** · phase 0 · `V-DEPLOY` `V-UNIT` — If an admission cap in a rendered configuration is not below the `max_instances` of its pool's container class ([qos-admission.md](qos-admission.md) FD-QOS-040), then the drift check must fail, naming the pool.
- **FD-OPS-021** · phase 0 · `V-DEPLOY` `V-PROOF` `V-DIFF` — If the placement policy validator in [qos-admission.md](qos-admission.md) rejects the placement rule set a deploy carries, then the drift check must fail with the validator's reason.
- **FD-OPS-022** · phase 0 · `V-DEPLOY` `V-LIVE` — The drift check must read the GitHub App's registration from the GitHub API and fail if it lacks a permission, grants a lower access level or lacks an event that the committed App manifest lists.
- **FD-OPS-023** · phase 0 · `V-DEPLOY` — If the GitHub App's registration subscribes to an event the committed App manifest does not list, then the drift check must report a warning and continue.
- **FD-OPS-024** · phase 0 · `V-DEPLOY` — `fd doctor` must run every drift check without changing any Cloudflare or GitHub state.
- **FD-OPS-025** · phase 0 · `V-DEPLOY` `V-LIVE` — The deploy workflow must run `fd doctor` every 24 h, and if a check fails, then raise the notify alarm `drift`.

### CI

- **FD-OPS-026** · phase 0 · `V-DEPLOY` — When a pull request opens or updates, CI must run lint, typecheck, unit tests, the formal build gate, `wrangler deploy --dry-run` for every Worker on configuration rendered from a placeholder overlay, the cron check of [intake.md](intake.md) FD-INT-050, the checks of FD-OPS-019 and FD-OPS-020, and the documentation site build.
- **FD-OPS-027** · phase 0 · `V-DEPLOY` — The repository must carry a GitHub Actions workflow that runs the CI commands of FD-OPS-026 on every `pull_request`, under a check name the ruleset does not require.
- **FD-OPS-028** · phase 0 · `V-LIVE` — This repository's ruleset must require the check `flare-dispatch/check:ci`, which the `check` recipe produces from this repository's repo manifest, on the default branch.
- **FD-OPS-029** · phase 0 · `V-UNIT` — The control plane must not change a repository ruleset.
- **FD-OPS-030** · phase 0 · `V-DEPLOY` — When a push to the default branch arrives, the deploy workflow must run the CI commands of FD-OPS-026 and start no deploy step until they pass.
- **FD-OPS-031** · phase 0 · `V-DEPLOY` — The documentation site must build its pages from the Markdown under `specs/`, and its build must fail on a broken local link or on a diagram that fails the diagram check.

### Configuration at runtime

- **FD-OPS-032** · phase 0 · `V-UNIT` — When a control-plane Worker starts serving, it must decode its environment with one `Schema` shared with `fd doctor`.
- **FD-OPS-033** · phase 0 · `V-UNIT` — If a control-plane Worker's environment fails to decode, then every route except `GET /health` must answer `503` with `{error: "misconfigured"}`, and `GET /health` must answer `503` with `failing: ["config"]`.

### Liveness

- **FD-OPS-034** · phase 0 · `V-UNIT` `V-LIVE` — `GET /health` must answer `200` with `{status: "ok", version}` when a D1 query, a KV read and an R2 head each succeed within 2 s, and must read no other binding.
- **FD-OPS-035** · phase 0 · `V-UNIT` — If the D1 query, the KV read or the R2 head fails or takes longer than 2 s, then `GET /health` must answer `503` with `{status: "degraded", failing}`, where `failing` lists component names and no id, hostname or secret name.
- **FD-OPS-036** · phase 0 · `V-UNIT` — `GET /v1/ops/health` must return each installation's status, the age of the last webhook delivery, the age of each cron trigger's last tick, each executor's heartbeat age, the outbox depth, the age of the oldest non-terminal execution and the control state.
- **FD-OPS-037** · phase 0 · `V-UNIT` `V-SIM` — When the minute tick fires, the control plane must record its time, and the alarm handler of the `LivenessMonitor` Durable Object, re-armed every 5 min, must raise the notify alarm `cron-silent` when that recorded time is older than 2 min.
- **FD-OPS-038** · phase 0 · `V-LIVE` — Every 15 min, the control plane must insert a `canary.push` outbox row keyed `cp:canary:<tick time>`, which the fixture installation's `InstallationQuota` ([architecture.md](architecture.md) FD-ARCH-003) applies as an empty commit on the canary branch of the fixture repository the operator overlay names, so GitHub delivers a real webhook to the dispatcher's public hostname.
- **FD-OPS-039** · phase 0 · `V-UNIT` — When the canary webhook arrives, the control plane must run the canary in the `control` pool with no container, at class P1 for queue order, admitted against the P1 line and charged to `R_ops` ([spend.md](spend.md) FD-SPD-036), and conclude its check `success`.
- **FD-OPS-040** · phase 0 · `V-LIVE` — If the canary check has no `success` conclusion 5 min after the canary push, then the control plane must raise the page alarm `canary-missed` naming the last stage the canary reached: delivery, intake, placement, verdict or check.
- **FD-OPS-041** · phase 0 · `V-LIVE` — Every 15 min, the control plane must read each registered installation through `GET /app/installations/{installation_id}` with the App JWT.
- **FD-OPS-042** · phase 0 · `V-LIVE` `V-UNIT` — If an installation read returns `404` or a suspended installation, then the control plane must raise the page alarm `installation-lost` naming the account login.
- **FD-OPS-043** · phase 0 · `V-UNIT` — When an `installation` event with action `deleted` or `suspend` arrives, the control plane must raise the page alarm `installation-lost` without waiting for the next installation read.
- **FD-OPS-044** · phase 0 · `V-LIVE` — Every 15 min, the control plane must list the App's webhook deliveries of the last 15 min through `GET /app/hook/deliveries`, and if any delivery has a non-2xx status, then raise the page alarm `delivery-failing` with the statuses and the count.
- **FD-OPS-045** · phase 0 · `V-UNIT` `V-LIVE` — When a webhook delivery from the last 24 h has a non-2xx status and no later successful attempt, the control plane must insert one `delivery.redeliver` outbox row keyed `cp:redeliver:<delivery id>` once the delivery path answers `2xx`, and apply it as one redelivery request made with the App JWT, the one App-JWT write [architecture.md](architecture.md) FD-ARCH-003 admits.
- **FD-OPS-046** · phase 0 · `V-LIVE` — Every 15 min, the control plane must send an `ok` heartbeat carrying the canary and probe results to the alert sink.
- **FD-OPS-047** · phase 0 · `V-LIVE` — Every 2 h, the control plane must run the Cloudflare container canary on the image digest the executors run: start a container, run one command, repeat it under the same exec key and expect the repeat to be deduplicated, request a host outside every grant and expect the egress proxy to refuse it, then stop the container.
- **FD-OPS-048** · phase 0 · `V-LIVE` — If a container canary stage fails, then the control plane must raise the page alarm `floor-canary-failed` naming the stage and the image digest.
- **FD-OPS-049** · phase 0 · `V-UNIT` — The control plane must keep a canary result keyed by executor kind and image digest for 24 h when it passed or failed and for 10 min when it was inconclusive, where inconclusive means the container did not start within 120 s or the platform answered `5xx`.
- **FD-OPS-050** · phase 0 · `V-DEPLOY` `V-LIVE` — When `fd deploy` has deployed the Workers, it must run the container canary once on the deployed image digest and must not report success until the canary passes.
- **FD-OPS-051** · phase 3 · `V-LIVE` — Where the AWS launcher is configured, every 24 h the control plane must run one canary task through the launcher, and if the task does not reach its verdict within 10 min, then raise the page alarm `floor-canary-failed`.
- **FD-OPS-052** · phase 1 · `V-SIM` `V-LIVE` — If no placement row is written for 30 min while at least one execution is queued and at least one executor heartbeat arrived in that window, then the control plane must raise the page alarm `placement-stalled`.

### Alerts

- **FD-OPS-053** · phase 0 · `V-UNIT` — The control plane must send every alarm, including those other spec files define, through one alert path that records the alarm in D1, shows it on the dashboard and sends it to the alert sink the operator overlay names.
- **FD-OPS-054** · phase 0 · `V-UNIT` — While an alarm's condition holds, the alert path must send that alarm at most once per dedupe key per 24 h.
- **FD-OPS-055** · phase 0 · `V-UNIT` — When an alarm's condition clears, the alert path must send one `resolved` message for its dedupe key.
- **FD-OPS-056** · phase 0 · `V-DEPLOY` — If the operator overlay names no alert sink, then `fd deploy` must reject the overlay.
- **FD-OPS-057** · phase 0 · `V-UNIT` — Every page-severity alarm message must name the runbook entry that handles it.
- **FD-OPS-058** · phase 0 · `V-UNIT` — If a send to the alert sink fails, then the alert path must retry it 3 times within 5 min and keep the alarm on the dashboard, and the failed send must not change any execution's verdict.

### Settle-sweep alarm

- **FD-OPS-059** — Removed; see [github-output.md](github-output.md) FD-GH-072.
- **FD-OPS-060** — Removed; see [github-output.md](github-output.md) FD-GH-073.
- **FD-OPS-061** — Removed; see [github-output.md](github-output.md) FD-GH-073.
- **FD-OPS-062** — Removed; see [github-output.md](github-output.md) FD-GH-073.
- **FD-OPS-063** · phase 0 · `V-UNIT` — When the settle sweep of [github-output.md](github-output.md) FD-GH-072 ends one or more executions, the control plane must raise the notify alarm `executions-lost` with the count and the run names.

### Dashboard and Access

- **FD-OPS-064** · phase 0 · `V-UNIT` `V-E2E-LOCAL` — Every dashboard page and route must pass the identity gate [interfaces.md](interfaces.md) assigns to its surface (FD-IFC-010 to FD-IFC-017), with the Access JWT checked against the overlay's `access.aud` and `access.teamDomain`.
- **FD-OPS-065** — Removed; see [interfaces.md](interfaces.md) FD-IFC-012 and FD-IFC-013.
- **FD-OPS-066** — Removed; see [interfaces.md](interfaces.md) FD-IFC-015.
- **FD-OPS-067** · phase 0 · `V-UNIT` — When the dashboard links a log or an artifact, the link must carry a link token ([interfaces.md](interfaces.md) FD-IFC-018) for that one object that expires within 3600 s.
- **FD-OPS-068** · phase 0 · `V-UNIT` — The executions view and its JSON route must filter by run, repository, class, status and executor kind, page with a keyset cursor at a default of 50 and a maximum of 200 rows, and show each execution's placement, executor, class, epoch, hold and settled cost.
- **FD-OPS-069** · phase 0 · `V-UNIT` — The executions routes must not return an execution's input payload or any secret value.
- **FD-OPS-070** · phase 0 · `V-UNIT` `V-MEASURE` — The dashboard must show, per class, the queue depth, the queue age p50 and p95, and the spill rate by target over the last 24 h, together with the active alarms and the control state.
- **FD-OPS-071** · phase 1 · `V-UNIT` — The fleet view must show each executor's kind, heartbeat age, drain and quarantine flags, and slots in use and in total per class.

### GitHub App install

- **FD-OPS-072** · phase 0 · `V-UNIT` — The GitHub App install routes must serve only an Access identity listed in the overlay's `operators`.
- **FD-OPS-073** · phase 0 · `V-UNIT` — The install flow must bind its `state` parameter to the operator's Access session and accept each state once within 600 s.
- **FD-OPS-074** · phase 0 · `V-UNIT` — If the install callback carries a `state` that is unknown, used or older than 600 s, then the control plane must answer `403` and exchange no code.
- **FD-OPS-075** · phase 0 · `V-UNIT` — The page that shows a new App's credentials must set `Cache-Control: no-store` and must be served only to the operator who started the flow.
- **FD-OPS-076** · phase 0 · `V-UNIT` — The committed App manifest must subscribe to the `installation` and `installation_repositories` events and request only the permissions [github-output.md](github-output.md) lists.

### Operator controls

- **FD-OPS-077** · phase 0 · `V-UNIT` — The control plane must offer the operator actions `halt` (to `run`, `halt-cloud` or `halt-all`), `drain`, `quarantine`, `release`, `force-admit`, `top-up` and `revoke`, each as a route under `/v1/ops/` and as an `fd ops` command that calls that route.
- **FD-OPS-078** · phase 0 · `V-UNIT` — The operator routes must accept a request only from an Access identity listed in the overlay's `operators`, and must answer `403` to any other identity.
- **FD-OPS-079** · phase 0 · `V-UNIT` — If an operator request carries no `reason` of 1 to 500 characters, then the control plane must reject it with `400`.
- **FD-OPS-080** · phase 0 · `V-UNIT` `V-CONF` — When an operator action changes state, the control plane must write an audit row with the identity, action, scope, reason, time and expiry in the same D1 batch (`db.batch()`) as the change.
- **FD-OPS-081** · phase 0 · `V-UNIT` — If a `force-admit` or `top-up` request has no expiry, or an expiry more than 7 days ahead, then the control plane must reject it with `400`.
- **FD-OPS-082** · phase 0 · `V-UNIT` — When a `force-admit` or `top-up` expiry passes, the control plane must end the grant and write an audit row.
- **FD-OPS-083** · phase 0 · `V-UNIT` — The operator actions must not change the budget the operator overlay sets; a lasting budget change goes through the overlay and a deploy.
- **FD-OPS-084** · phase 0 · `V-UNIT` — While the control state is not `run`, or any quarantine, force-admit or top-up is active, the control plane must raise the notify alarm `operator-control` once every 24 h.
- **FD-OPS-085** · phase 0 · `V-UNIT` — When an operator quarantines a repository, intake must admit no new execution for it until the operator releases it, and must conclude each request for it `failure` with the reason `operator: repo quarantined`.
- **FD-OPS-086** · phase 1 · `V-UNIT` `V-SIM` — When an operator quarantines an executor, the control plane must increment the epoch of each execution leased to it, revoke its lease credentials and keep it out of placement until the operator releases it.
- **FD-OPS-087** · phase 1 · `V-UNIT` `V-SIM` — When an operator revokes a device, the control plane must remove the device key from the executor registry, increment the epoch of each execution leased to the device and revoke its execution-lease and capacity-lease credentials.

### Access configuration and webhook silence

- **FD-OPS-088** · phase 0 · `V-DEPLOY` `V-E2E-LOCAL` — The committed Access configuration must bypass Access on every path whose surface in [interfaces.md](interfaces.md) names an identity other than the Access JWT alone (webhook, dispatch, executor connect, `/health`, `/.well-known/*`, log, artifact, compile-cache, model-gateway and `/v1/provenance/*` paths), and the dispatcher must run each such surface's identity check itself.
- **FD-OPS-089** · phase 0 · `V-UNIT` `V-LIVE` — If an installation with at least one repository whose manifest enrolls a recipe has no verified webhook delivery ([intake.md](intake.md) FD-INT-031) for `alerts.webhookSilentHours`, then the control plane must raise the notify alarm `webhook-silent` naming the account login.

## Open items

- TODO(operator): choose an alert sink that pages when no `ok` heartbeat arrives for 30 min; without one, a control plane that stops serving raises no alarm.
- TODO(maintainer): decide whether a control plane hosted on Postgres outside Cloudflare renders from the same value schema or from its own.
