# Run model

FlareDispatch's runs are mameko run definitions: typed Effect programs written with `defineRun`, executed by mameko's runner, that end with one outcome and a list of intents the control plane applies. This file specifies what FlareDispatch adds to mameko's run model: the trigger event its runs read, the `GithubRead` capability, the failure reason kinds, cancel causes and not-applicable details its run catalogue declares, and the `signals/v1` contract.

## Scope

mameko's [run-model.md](https://github.com/fractalboxdev/mameko/blob/88770c64b14818ad32aed9615f1cfaf4bbc1f591/specs/run-model.md) specifies `defineRun` and its bounds, the capability → primitive → run layering, steps, the run ceiling, the outcome partition, the error taxonomy, intents and their keys, child executions and the boundary-contract rule. FlareDispatch inherits them unchanged. Which outcomes each intent kind applies for, the outcome mapping onto check-run conclusions and the cancel causes and not-applicable details the profile declares are profile values ([profile.md](profile.md) § Outcome mapping, § Intent kinds).

This file depends on:

- [profile.md](profile.md) for the outcome mapping and the intent kinds;
- [github-output.md](github-output.md) for `checkConclusion` and how each intent kind reaches GitHub;
- [intake.md](intake.md) for the triggers that produce a `DispatchEvent`;
- [runs/gate.md](runs/gate.md) and [runs/agentic.md](runs/agentic.md) for the recipes and the reasons they produce;
- [interfaces.md](interfaces.md) for the dispatch that carries `signals`.

The decisions behind the run model are mameko's [ADR-0004](https://github.com/fractalboxdev/mameko/blob/88770c64b14818ad32aed9615f1cfaf4bbc1f591/specs/adr/0004-effect-workflow-owned-backends.md) (`effect/workflow` as the single run model) and [ADR-0005](https://github.com/fractalboxdev/mameko/blob/88770c64b14818ad32aed9615f1cfaf4bbc1f591/specs/adr/0005-run-body-in-executor.md) (run bodies in the executor, side effects as intents).

## Model

### Run definitions

FlareDispatch's run catalogue calls mameko's `defineRun(spec, body, catalogue)`, with `catalogue.classRanks` read from the profile's classes. `defineRun` decodes the fields mameko bounds, returns only those, and accepts in `requires` only mameko's capability names. FlareDispatch's own declarations therefore sit in each run's catalogue entry beside `defineRun`'s answer: `triggers`, the check label, the cooldown, the `writeback` block, the model call sites, the data classes and the use of `GithubRead`.

### Runner entry

FlareDispatch's run-catalogue bundle has one entry, which imports the run registry and calls mameko's `runnerMain` with it, so the catalogue and the runner carry one copy of `effect`. On a device, the device configuration pins the bundle ([MAMEKO-EXEC-121](https://github.com/fractalboxdev/mameko/blob/88770c64b14818ad32aed9615f1cfaf4bbc1f591/specs/executors.md)), and the device executor starts one runner child per lease with a run payload built from the `exec.lease` fields ([MAMEKO-PROTO-084](https://github.com/fractalboxdev/mameko/blob/88770c64b14818ad32aed9615f1cfaf4bbc1f591/specs/executor-protocol.md)). That payload's `attempt` counts the earlier leases of one execution and is not the attempt number of a check family ([README.md](README.md) § Glossary).

### Triggers

A run's `triggers` are mameko request decoders: functions from the decoded `DispatchEvent` union to `Option` of the run's decoded input. `DispatchEvent` has one member per trigger kind FlareDispatch accepts: a GitHub webhook, an Actions dispatch, a cron tick, a local submit and an MCP call ([intake.md](intake.md)). The missed-webhook sweep, a check re-run and a `dispatch.followOn` intent reach a trigger as one of those members.

### `GithubRead`

`GithubRead` is FlareDispatch's application capability, declared in its run catalogue with the shape mameko gives every capability: a service interface, one Layer per executor kind and tagged errors.

| Capability | Serves | Fails with |
| --- | --- | --- |
| `GithubRead` | Reads of the repository and its pull requests under the per-lease token the egress proxy attaches | `GithubReadFailed`, `GithubUncredentialed` |

A failed read is an error, never an empty answer: a caller that took `[]` as "no prior review" or "no open pull request" would decide on a false fact.

### Reason kinds

FlareDispatch's run catalogue declares the failure reason kinds below in addition to mameko's reason table. The profile's `reason_kinds` declares `provenance` ([profile.md](profile.md) § Reason kinds). FlareDispatch also produces reasons of mameko's kinds: `infra: no verdict` ([github-output.md](github-output.md)), `infra: edit loop unavailable` and `policy: trifecta` ([runs/agentic.md](runs/agentic.md)), and `capacity: deferred` through the outcome mapping.

| Kind | Category | Reasons | Produced in |
| --- | --- | --- | --- |
| `exit` | `finding` | `exit: <code>`, `exit: signal <name>` | [runs/gate.md](runs/gate.md) |
| `timeout` | `finding` | `timeout: job` | [runs/gate.md](runs/gate.md) |
| `output` | `finding` | `output: over limit` | [runs/gate.md](runs/gate.md) |
| `install` | `finding` | `install: exit <code>` | [runs/gate.md](runs/gate.md) |
| `discover` | `finding` | `discover: exit <code>` | [runs/gate.md](runs/gate.md) |
| `jobs` | `finding` | `jobs: <keys>` | [runs/gate.md](runs/gate.md) |
| `smoke` | `finding` | `smoke: <host><path> <status or error>` | [runs/gate.md](runs/gate.md) |
| `image` | `finding` | `image: <name> <arch> <step>`, `image: unpinned input <name>`, `image: <name> linux/arm64 emulation unavailable` | [runs/gate.md](runs/gate.md) |
| `review` | `finding` | `review: changes requested` | [runs/agentic.md](runs/agentic.md) |
| `no-fix` | `finding` | `no-fix` | [runs/agentic.md](runs/agentic.md) |
| `suppression` | `infra` | `suppression: read failed` | [runs/agentic.md](runs/agentic.md) |
| `writeback` | `policy` | `writeback: <first reason kind>` | [runs/agentic.md](runs/agentic.md) |
| `intent` | `policy` | `intent: undeclared kind` | [runs/agentic.md](runs/agentic.md) |
| `release` | `policy` | `release: tag not on default branch`, `release: tag moved` | [runs/gate.md](runs/gate.md) |
| `provenance` | `policy` | `provenance: <check>` | [provenance.md](provenance.md) |

### Cancel causes and not-applicable details

The profile declares two cancel causes beyond mameko's `superseded`, `parent-ended` and `operator-cancel`:

| Cause | Produced when | Produced in |
| --- | --- | --- |
| `pr-closed` | The pull request closes | [profile.md](profile.md) FD-PROF-030 |
| `merge-group-destroyed` | A `merge_group` event with action `destroyed` names the execution's head SHA | [github-output.md](github-output.md) FD-GH-076 |

A run produces `skipped` only from `NotApplicable` with one of the details the profile lists; the outcome mapping sends a listed skip to `neutral` and any other skip to `failure` ([profile.md](profile.md) § Outcome mapping).

| Detail | Produced when | Produced in |
| --- | --- | --- |
| `draft-pr` | The pull request is a draft | [runs/gate.md](runs/gate.md) FD-GATE-017, [runs/agentic.md](runs/agentic.md) FD-AGT-046 |
| `author-excluded` | The pull request's author is excluded by the repo manifest or is a bot | [runs/gate.md](runs/gate.md) FD-GATE-017, [runs/agentic.md](runs/agentic.md) FD-AGT-046 |
| `path-filter` | No changed path matches the run's path filter | Admission, before placement |
| `not-configured` | The repository opts out of the run, for example with the `skip-ai-review` label | [runs/agentic.md](runs/agentic.md) FD-AGT-046 |
| `nothing-to-lint` | The linter finds no file to lint | [runs/gate.md](runs/gate.md) FD-GATE-024 |
| `every-job-skipped` | Every job of a job matrix recorded `skipped` | [runs/gate.md](runs/gate.md) FD-GATE-039 |
| `empty-range` | The release commit range is empty | [runs/agentic.md](runs/agentic.md) FD-AGT-082 |

`checkConclusion` turns each outcome into a check-run conclusion under the profile's outcome mapping ([github-output.md](github-output.md) FD-GH-021 to FD-GH-029).

### Intents

FlareDispatch's intent kinds, the outcomes each applies for and the GitHub call behind each are in [profile.md](profile.md) § Intent kinds; `pr.propose`, `release.draft` and `release.publish` apply for `success` only. The effect applier for `pr.propose` runs the staged-write gate and answers `refused` when the gate rejects the staged write ([runs/agentic.md](runs/agentic.md)).

## Requirements

### Triggers

- **FD-RUN-008** · phase 0 · `V-UNIT` — The decoded request union that FlareDispatch's request decoders take under [MAMEKO-RUN-010](https://github.com/fractalboxdev/mameko/blob/88770c64b14818ad32aed9615f1cfaf4bbc1f591/specs/run-model.md) must be the `DispatchEvent` union of § Triggers, with one member per trigger kind.

### Definitions

- **FD-RUN-061** · phase 0 · `V-UNIT` — The run catalogue must pass `defineRun` the rank of each class of the profile as its `catalogue` argument ([MAMEKO-RUN-006](https://github.com/fractalboxdev/mameko/blob/88770c64b14818ad32aed9615f1cfaf4bbc1f591/specs/run-model.md)).
- **FD-RUN-062** · phase 0 · `V-UNIT` — The run catalogue must keep every declaration `defineRun` does not decode in the run's catalogue entry, and must list in `requires` only mameko's capability names, so that `GithubRead` stays out of `requires`.
- **FD-RUN-063** · phase 1 · `V-UNIT` `V-E2E-LOCAL` — FlareDispatch's run-catalogue bundle must have one entry that calls `runnerMain` with the run registry, the only list of runs ([MAMEKO-RUN-008](https://github.com/fractalboxdev/mameko/blob/88770c64b14818ad32aed9615f1cfaf4bbc1f591/specs/run-model.md), [MAMEKO-EXEC-121](https://github.com/fractalboxdev/mameko/blob/88770c64b14818ad32aed9615f1cfaf4bbc1f591/specs/executors.md)).

### Capabilities

- **FD-RUN-017** · phase 0 · `V-UNIT` `V-CONF` — If a `GithubRead` read fails, then `GithubRead` must fail with `GithubReadFailed` or `GithubUncredentialed` and must not return an empty list, `undefined` or `Option.none` ([MAMEKO-RUN-022](https://github.com/fractalboxdev/mameko/blob/88770c64b14818ad32aed9615f1cfaf4bbc1f591/specs/run-model.md)).

### Outcomes

- **FD-RUN-057** · phase 0 · `V-UNIT` — FlareDispatch's run catalogue must declare every reason kind of § Reason kinds except `provenance`, each in the category that table gives, so that under [MAMEKO-RUN-055](https://github.com/fractalboxdev/mameko/blob/88770c64b14818ad32aed9615f1cfaf4bbc1f591/specs/run-model.md) a `failure` reason with any other kind fails typecheck.

### Contracts

- **FD-RUN-054** · phase 0 · `V-UNIT` — The `signals/v1` JSON Schema that FlareDispatch publishes must be generated from its `Schema` definition, and CI must fail when the committed file differs from the generated one.

## Open items

- TODO(maintainer): decide whether `Finding` tags beyond `CheckFailed`, `TestsFailed` and `ReviewBlocked` live in the run catalogue's shared module or in each recipe.
