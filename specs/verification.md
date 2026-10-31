# Verification

This file specifies how FlareDispatch proves that each of its requirements holds: the harness behind each verification tag, where it lives and when it runs, the merge gate and the phase gates that read the harness results, the `spec-tags` check over FlareDispatch's requirement lines and its moved-ID table, the run of mameko's conformance suite on FlareDispatch's composed control plane, the diff of FlareDispatch's profile against mameko's reference CI profile, and the formal properties FlareDispatch proves itself: the staged-write gate, the cache namespaces and the provenance protocol.

## Scope

This file covers the ten verification tags of [README.md](README.md), the CI jobs that run them, the merge gate, the phase gates, the `spec-tags` check, FlareDispatch's formal gate (Lean 4 for the staged-write gate and the cache namespaces, Tamarin for provenance, differential testing of `stagedWriteGate`) and the coverage counts. Tags are inline on each requirement, so this file holds no row per requirement: a requirement's tags name its harnesses, and its phase names the gate that requires those harnesses to pass.

mameko's [verification.md](https://github.com/fractalboxdev/mameko/blob/3af65c59d5f30123eb55b468966b4975c7395ece/specs/verification.md) specifies the harnesses for mameko's own requirements: the coordinator conformance suite, the kernels' Lean models and differential testing, the fleet simulation and the replay check. FlareDispatch runs mameko's conformance suite against its own composed control plane (FD-VER-032) and cites mameko's theorems for the properties of the mechanism it inherits; it does not re-prove them.

It depends on [README.md](README.md) for the requirement format, the area table, the tag table and the moved-ID table; on [roadmap.md](roadmap.md) for the phases, the `V-MEASURE` thresholds and the kill lines; on [operability.md](operability.md) for the deploy workflow, the drift check, the canary and the alarms; on [profile.md](profile.md) for the profile the reference diff reads; on [provenance.md](provenance.md) for the Tamarin gate (FD-PROV-072, FD-PROV-073); and on [adr/0018-formal-models.md](adr/0018-formal-models.md) for the Tamarin model.

## Model

### From requirement to gate

A requirement line carries its phase and one or more tags. Each tag names one harness family. A harness entry covers a requirement when it names the requirement's ID: a test title that contains `[FD-<AREA>-NNN]`, a Lean theorem whose docstring lists the ID, or a Tamarin lemma whose comment lists it. The `spec-tags` check joins requirement lines to harness entries and reports, per tag, each requirement with no entry. The merge gate requires every harness that runs per pull request to pass. The phase gate for phase n requires, for every requirement of phase n or lower, a passing entry for each of its tags.

The current phase is the single digit in `.github/phase`. A pull request that changes it is a phase-gate pull request.

### Harness catalog

#### `V-UNIT`

- **Runs:** `@effect/vitest` suites over test Layers: mameko's memory runtime adapter, a fake GitHub that records every call, and a fake executor that returns scripted results. It covers the appliers, `checkConclusion`, the installation rate limit, `resolveClass`, the profile's bindings, validators and pure functions.
- **Lives:** `test/unit/` or `src/*.test.ts` in each workspace package and app, run by `pnpm test`.
- **Runs when:** every pull request and every push to the default branch, in the `unit` job.
- **Failure blocks:** the merge.

#### `V-CONF`

- **Runs:** one conformance suite per interface, run unchanged against every backend of that interface:
  - mameko's coordinator suite of `packages/conformance`, against FlareDispatch's composed control plane: `host-cloudflare` under workerd with FlareDispatch's profile, its appliers on the fake GitHub, and the fake executor (FD-VER-032);
  - executors: the `gha` launcher and the fake executor;
  - provenance acceptance: one negative test per acceptance check and per verifier rejection (FD-PROV-072).
- **Lives:** mameko's suite as an installed package; FlareDispatch's own suites in `packages/conformance/`.
- **Runs when:**
  - every pull request, in the `conf` job, for the composed control plane, the R2 conditional writes of [cache-artifacts.md](cache-artifacts.md) and the fake executor;
  - nightly and on every phase-gate pull request, for the `device` executor on an owned device from phase 1, the `aws` executor from phase 3 and the `gha` executor from phase 4.
- **Failure blocks:** the merge for the per-pull-request backends; the phase gate for the nightly backends.

#### `V-SIM`

- **Runs:** a deterministic simulation on `TestClock` with fault injection, over FlareDispatch's composed control plane: a late result after reclaim, a webhook redelivery, a `401` and a `Retry-After` from GitHub, an installation at its reserve, and a D1 transaction failure. Each scenario takes a seed that fixes every interleaving.
- **Lives:** `test/sim/`, with failing seeds kept in `test/sim/seeds.jsonl`.
- **Runs when:** every pull request with 100 seeds per scenario plus every kept seed, in the `sim` job; nightly with 10,000 seeds per scenario.
- **Failure blocks:** the merge (per pull request); the phase gate (nightly).

#### `V-REPLAY`

- **Runs:** every workflow twice over the journal of its first run, counting GitHub calls, D1 writes and intents on the second run.
- **Lives:** `test/replay/`.
- **Runs when:** every pull request, in the `replay` job.
- **Failure blocks:** the merge. One extra GitHub call, D1 write or intent fails the job.

#### `V-E2E-LOCAL`

- **Runs:** the full stack on one machine: the Workers under workerd (`wrangler dev`), a device executor from mameko's device bundle, a recorded GitHub fixture server and a local job sandbox.
- **Lives:** `test/e2e-local/`, with the GitHub recordings in `test/e2e-local/fixtures/`.
- **Runs when:**
  - every pull request, in the `e2e-local` job, for the cloud path (workerd, the fixture server and a local container as the `cloudflare` executor);
  - nightly and on every phase-gate pull request, for the device path on an owned device from phase 1.
- **Failure blocks:** the merge for the cloud path; the phase gate for the device path.

#### `V-DEPLOY`

- **Runs:** `wrangler deploy --dry-run` for every Worker, mameko's profile validator and configuration validation over the committed profile and configuration, the reference-profile diff (FD-VER-033), and the overlay drift check of [operability.md](operability.md).
- **Lives:** the `deploy-dry-run` and `profile-reference` jobs and the deploy workflow in `.github/workflows/`; the drift check is `fd doctor`.
- **Runs when:** every pull request, against the committed placeholders; every deploy, against the operator overlay; every 24 h, as `fd doctor` (FD-OPS-025).
- **Failure blocks:** the merge (dry run, validators and reference diff); the deploy (drift check).

#### `V-LIVE`

- **Runs:** the synthetic webhook canary every 15 min (FD-OPS-038, FD-OPS-040), the installation probe every 15 min (FD-OPS-041), the webhook delivery scan (FD-OPS-044), the post-deploy probe (FD-OPS-013), `pr-review` on this repository's pull requests, and mameko's floor canaries on the deployed control plane.
- **Lives:** the control plane's cron and ops intents; results reach the alert sink and the dashboard.
- **Runs when:** live, on every deploying organization's control plane.
- **Failure blocks:** no merge. It raises the page alarm the requirement names, and the phase gate reads the alarm record of its window.

#### `V-MEASURE`

- **Runs:** a metric computed from the executions table and its siblings (claim latency, cloud placement rate, epoch discards, verdict audit disagreements, time to verdict per run and executor kind, cache hit rate), compared with a threshold.
- **Lives:** the control plane's metric queries; the dashboard shows them (FD-OPS-070) and `GET /v1/spend` serves the spend metrics.
- **Runs when:** live. The phase gate reads each metric over its window; the kill-line monitor reads each metric daily.
- **Failure blocks:** the phase gate. A crossed kill line raises the `kill-line` notification and stops the next phase until the operator decides.

#### `V-PROOF`

- **Runs:** `lake build` over FlareDispatch's Lean 4 project, the forbidden-term scan, `#print axioms` for every theorem, and `tamarin-prover --prove` over the provenance model.
- **Lives:** `formal/` at the repository root: `formal/FdFormal/*.lean` for the staged-write gate and the cache namespaces, `formal/provenance.spthy` for provenance, `formal/lean-toolchain` and a pinned prover version for the tools. A theorem about mameko's mechanism lives in mameko's `formal/` and is cited by name.
- **Runs when:** every pull request and every push to the default branch, in the `formal` job.
- **Failure blocks:** the merge. A proof counts toward a phase gate only while every assumption test of its row in the formal property table passes on the same commit.

#### `V-DIFF`

- **Runs:** `fast-check` traces through `stagedWriteGate` and through the native oracle compiled from its Lean model, comparing outputs after every event. mameko's kernels are differentially tested in mameko ([mameko verification.md § Differential testing](https://github.com/fractalboxdev/mameko/blob/3af65c59d5f30123eb55b468966b4975c7395ece/specs/verification.md#differential-testing)).
- **Lives:** `test/diff/` for the generators and the comparison, the `oracle` executable built by `lake build oracle` in `formal/`, and `formal/regressions.jsonl` for every trace that ever differed.
- **Runs when:** every pull request with 10,000 traces, in the `diff` job; nightly with 1,000,000 traces. Every run first replays every line of `formal/regressions.jsonl`.
- **Failure blocks:** the merge (per pull request); the phase gate (nightly).

### Merge gate

The default branch's ruleset requires these checks on every pull request. A pull request merges only when every one concludes `success`.

| Check | Runs | Tags it serves |
| --- | --- | --- |
| `lint` | `pnpm lint` | — |
| `typecheck` | `pnpm typecheck` | — |
| `spec-tags` | The requirement-line check (FD-VER-001 to FD-VER-013, FD-VER-034 to FD-VER-037) | all |
| `unit` | `pnpm test` | `V-UNIT` |
| `conf` | mameko's coordinator suite on the composed control plane, and FlareDispatch's suites over the per-pull-request backends | `V-CONF` |
| `sim` | 100 seeds per scenario plus every kept seed | `V-SIM` |
| `replay` | Double run over cached journals | `V-REPLAY` |
| `e2e-local` | The cloud path of the end-to-end stack | `V-E2E-LOCAL` |
| `deploy-dry-run` | `wrangler deploy --dry-run` and the validators | `V-DEPLOY` |
| `profile-reference` | The comparison of FlareDispatch's profile with mameko's reference CI profile at the pinned commit, outside the listed differences (FD-VER-033, FD-PROF-002) | `V-DEPLOY` |
| `formal` | `lake build`, the forbidden-term scan, `#print axioms`, `tamarin-prover --prove` | `V-PROOF` |
| `diff` | The regressions file, then 10,000 traces of `stagedWriteGate` | `V-DIFF` |

`V-LIVE` and `V-MEASURE` run against a deployed control plane and are not merge checks.

### Phase gates

A phase-gate pull request moves `.github/phase` from n to n + 1. Its `phase-gate` job passes only when every condition holds:

1. Every requirement of phase n or lower has a passing harness entry for each of its tags other than `V-LIVE` and `V-MEASURE`, on the pull request's base commit.
2. Every nightly harness (`conf` device and launcher backends, `sim` with 10,000 seeds, `e2e-local` device path, `diff` with 1,000,000 traces) passed on the base commit or a later nightly run.
3. Every `V-PROOF` requirement of phase n or lower names a theorem or lemma that the formal gate proves, and every assumption test of its row passes.
4. No `V-LIVE` page alarm of a phase n or lower requirement stayed unresolved for more than 24 h in the gate window.
5. Every `V-MEASURE` threshold of gate n in [roadmap.md](roadmap.md) holds over its window.

```mermaid
flowchart LR
  accTitle: CI gates from pull request to phase transition
  pr([Pull request])
  subgraph mergeGate["Merge gate: every pull request"]
    tags[spec-tags]
    static[lint and typecheck]
    tests[unit, conf, sim, replay]
    e2e[e2e-local cloud path]
    dry[deploy-dry-run]
    formal["formal: Lean, Tamarin"]
    diff["diff: 10k traces"]
    mconf[mameko conformance on the composed host]
    pref[profile-reference]
  end
  mg{All checks success?}
  refused([Merge refused])
  main[Default branch]
  subgraph deployZone["Deploy"]
    drift{Drift check passes?}
    dep[wrangler deploy and probe]
  end
  subgraph nightly["Nightly on the default branch"]
    deep[diff 1M, sim 10k seeds]
    device[conf and e2e-local on an owned device]
  end
  subgraph live["Live control plane"]
    canary[Canary and installation probe]
    metrics[(Executions table)]
  end
  reg[(regressions.jsonl and seeds.jsonl)]
  pg{Phase gate passes?}
  next([Next phase])
  held([Phase held])
  pr --> tags
  pr --> static
  pr --> tests
  pr --> e2e
  pr --> dry
  pr --> formal
  pr --> diff
  pr --> mconf
  pr --> pref
  tags --> mg
  static --> mg
  tests --> mg
  e2e --> mg
  dry --> mg
  formal --> mg
  diff --> mg
  mconf --> mg
  pref --> mg
  mg e1@-->|no| refused
  mg -->|yes| main
  main --> drift
  drift -->|yes| dep
  main --> deep
  main --> device
  deep e2@-.->|failing seed| reg
  reg -.->|replayed every run| diff
  dep --> canary
  canary --> metrics
  deep --> pg
  device --> pg
  metrics --> pg
  pg -->|yes| next
  pg e3@-->|no| held
  class pr accent
  class mg,drift,pg warn
  class refused,held danger
  class next ok
  class metrics,reg store
  class mergeGate,deployZone,nightly,live group
  class e1,e3 failure
  class e2 async
```

*CI gates · a pull request merges on the per-pull-request harnesses; a phase moves only when the nightly harnesses, the proofs with their assumption tests and the live metrics all pass.*

### Formal gate

The `formal` job fails on any of these:

- `lake build` in `formal/` fails under the toolchain that `formal/lean-toolchain` pins exactly.
- A `.lean` file in `formal/` contains `sorry`, `admit`, `native_decide` or an `axiom` declaration.
- `#print axioms` for a theorem in `formal/` lists an axiom other than `propext`, `Classical.choice` and `Quot.sound`.
- `tamarin-prover --prove formal/provenance.spthy`, at the pinned prover version, reports a lemma other than `verified`. An expected attack is stated as an `exists-trace` lemma, so the attack trace that lemma finds is a pass (FD-PROV-073).

The `diff` job runs every line of `formal/regressions.jsonl`, then 10,000 generated traces per pull request or 1,000,000 nightly, through `stagedWriteGate` and the oracle built from the same commit. The first trace whose outputs differ fails the job; the harness shrinks it and writes it as one `regressions.jsonl` line.

```mermaid
flowchart TB
  accTitle: Proof, oracle, TypeScript kernel and assumption tests
  subgraph formalZone["formal/"]
    model[Lean model of stagedWriteGate and the cache namespaces]
    thm[Theorems named by requirement ID]
    oracle[Compiled native oracle]
    spthy[Tamarin lemmas S7a to S7e]
  end
  subgraph cp["Control plane (TypeScript)"]
    kernel["stagedWriteGate: manifest to accept or reject"]
    accept[Result-acceptance checks]
  end
  subgraph assume["Assumption tests"]
    conf[V-CONF suites]
    sim[V-SIM simulation]
  end
  gen[fast-check trace generator]
  cmp{Outputs equal on every trace?}
  reg[(formal/regressions.jsonl)]
  counts([Proof counts toward the phase gate])
  void([Proof does not count])
  model --> thm
  model --> oracle
  gen --> oracle
  gen --> kernel
  oracle --> cmp
  kernel --> cmp
  cmp e1@-->|no| reg
  reg -.->|replayed first| gen
  spthy -.->|assumes each check rejects| accept
  conf -->|negative test per check| accept
  sim -->|tests| kernel
  cmp -->|yes| counts
  assume -->|every assumption test passes| counts
  assume e2@-->|a test missing or failing| void
  class gen accent
  class cmp warn
  class reg store
  class counts ok
  class void danger
  class formalZone,cp,assume group
  class e1,e2 failure
```

*Proof to code · the oracle ties the staged-write theorem to the TypeScript kernel through differential testing, and the conformance tests tie the Tamarin model's assumptions to the acceptance checks.*

### Formal properties

Each row maps one property to the FlareDispatch requirements it covers, the theorem or lemma that proves it and the `V-CONF` or `V-SIM` requirements that test the assumptions the proof uses. A name marked *proved* checks under the formal gate; a name marked *planned* is the theorem the requirement's `V-PROOF` tag names before it exists. Lean theorems live in `formal/FdFormal/` and Tamarin lemmas in `formal/provenance.spthy`. The properties of mameko's mechanism (the spend bound, the lines, fencing, the outbox, placement, credentials and egress) are mameko's rows in [mameko verification.md § Formal properties](https://github.com/fractalboxdev/mameko/blob/3af65c59d5f30123eb55b468966b4975c7395ece/specs/verification.md#formal-properties).

| Property | Statement | Requirements | Theorem or lemma | Assumption tests |
| --- | --- | --- | --- | --- |
| S3 · profile | FlareDispatch's profile keeps `untrusted-input`, `cloud-pinned` and `cloud-only` work off devices and `local-only` work off the cloud, and the profile validator rejects a profile that leaves a `required` request unplaceable | FD-INT-030, FD-INT-061, FD-OPS-021, FD-GATE-061, FD-GATE-080 | mameko's `Placement` theorems over the profile, row S3 · executors of mameko's table | mameko's assumption tests of that row |
| S5 · trifecta | No run declaration combines private data, untrusted input and outbound access | FD-AGT-004 | `Egress.no_trifecta_declaration` *planned* | FD-AGT-005 (runtime trifecta refusal) |
| S6 | A pull-request-namespace writer cannot change what a protected-trigger reader restores | FD-CACHE-015, FD-CACHE-017, FD-CACHE-018, FD-CACHE-019, FD-CACHE-022, FD-CACHE-023, FD-CACHE-027, FD-CACHE-029, FD-CACHE-058 | `Cache.pr_writer_noninterference` *planned* | FD-CACHE-016, FD-CACHE-041 (namespaces from the lease, create-only manifests), with read-only cache directories under [MAMEKO-ISO-004](https://github.com/fractalboxdev/mameko/blob/3af65c59d5f30123eb55b468966b4975c7395ece/specs/isolation-egress.md) |
| S7a | Injective agreement: an accepted statement was signed by the device its lease was issued to, and no other accepted statement carries its nonce, unless that device key was revealed before it signed | FD-PROV-010, FD-PROV-013, FD-PROV-014, FD-PROV-017, FD-PROV-018, FD-PROV-020, FD-PROV-021, FD-PROV-032 | `injective_agreement` *planned* | FD-PROV-013, FD-PROV-014, FD-PROV-017, FD-PROV-018, FD-PROV-020, FD-PROV-021 |
| S7b | Freshness: no statement for epoch k is accepted after a reclaim to k + 1, and no statement produced before its lease is accepted | FD-PROV-011, FD-PROV-012, FD-PROV-019 | `freshness` *planned* | FD-PROV-011, FD-PROV-019 |
| S7c | Compromise scope: a revealed device key yields countersignatures only for that device's leases while it is registered and not revoked, and never the `reproduced` tier | FD-PROV-009, FD-PROV-015, FD-PROV-057, FD-PROV-061 | `compromise_scope` *planned* | FD-PROV-009, FD-PROV-015, FD-PROV-057, FD-PROV-061 |
| S7d | Misuse detection: every statement a verifier accepts has a log entry | FD-PROV-054 | `misuse_detection` *planned*; `skip_inclusion_attack` (`exists-trace`) *planned* | FD-PROV-054 |
| S7e | Rotation: a countersignature by a retired provenance key is rejected outside its validity window | FD-PROV-047, FD-PROV-048, FD-PROV-056 | `rotation` *planned*; `no_key_history_attack` (`exists-trace`) *planned* | FD-PROV-056 |
| S7 · gate | Every lemma is `verified`, and each acceptance check a lemma assumes has a passing negative test | FD-PROV-072, FD-PROV-073 | Every lemma of `formal/provenance.spthy` | FD-PROV-013, FD-PROV-014, FD-PROV-015, FD-PROV-017, FD-PROV-018, FD-PROV-019, FD-PROV-020, FD-PROV-021, FD-PROV-054, FD-PROV-056, FD-PROV-057, FD-PROV-061 |
| S8 | A model-authored staged write never touches `runs/`, `infra/`, `.github/workflows/` or a `wrangler.jsonc`, and one failing entry rejects the whole manifest | FD-AGT-016, FD-AGT-017, FD-AGT-020, FD-LOCAL-094 | `StagedWrite.model_authored_protected_paths`, `StagedWrite.reject_whole_manifest` *planned* | FD-AGT-009, FD-AGT-012 (every write is an intent; the manifest holds every tracked and untracked change) |

A property that is an exhaustive mapping over a closed union, such as "no capacity outcome concludes `neutral`", has no row: an exhaustive `Match` and a `V-UNIT` test cover it.

### Coverage

Counts come from the requirement lines under `specs/`, the example line in [README.md](README.md) excluded; FD-VER-009 keeps them equal to the files. A requirement with several tags counts once under each tag, so a row's tag counts sum to more than its total.

**By phase**

| Phase | Requirements | `V-UNIT` | `V-CONF` | `V-SIM` | `V-REPLAY` | `V-E2E-LOCAL` | `V-DEPLOY` | `V-LIVE` | `V-MEASURE` | `V-PROOF` | `V-DIFF` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 516 | 471 | 22 | 31 | 14 | 29 | 46 | 22 | 4 | 14 | 11 |
| 1 | 51 | 44 | 8 | 3 | 1 | 6 | 2 | 0 | 2 | 3 | 0 |
| 2 | 56 | 56 | 0 | 4 | 1 | 4 | 0 | 0 | 0 | 1 | 1 |
| 3 | 26 | 24 | 0 | 1 | 0 | 2 | 1 | 0 | 0 | 0 | 0 |
| 4 | 97 | 60 | 30 | 8 | 2 | 6 | 6 | 1 | 0 | 22 | 0 |
| All | 746 | 655 | 60 | 47 | 18 | 47 | 55 | 23 | 6 | 40 | 12 |

**By area**

| Area | Total | By phase 0 · 1 · 2 · 3 · 4 | `V-UNIT` | `V-CONF` | `V-SIM` | `V-REPLAY` | `V-E2E-LOCAL` | `V-DEPLOY` | `V-LIVE` | `V-MEASURE` | `V-PROOF` | `V-DIFF` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ARCH` | 9 | 7 · 1 · 0 · 1 · 0 | 6 | 1 | 0 | 0 | 6 | 1 | 0 | 0 | 0 | 0 |
| `CACHE` | 90 | 71 · 18 · 1 · 0 · 0 | 83 | 11 | 7 | 1 | 4 | 3 | 0 | 1 | 9 | 0 |
| `PROTO` | 1 | 0 · 0 · 0 · 0 · 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `EXEC` | 11 | 0 · 2 · 0 · 1 · 8 | 5 | 2 | 2 | 0 | 1 | 2 | 0 | 0 | 0 | 0 |
| `GH` | 65 | 63 · 1 · 1 · 0 · 0 | 64 | 4 | 6 | 6 | 2 | 0 | 2 | 0 | 0 | 0 |
| `INT` | 50 | 46 · 1 · 2 · 1 · 0 | 49 | 2 | 7 | 0 | 5 | 3 | 1 | 0 | 2 | 0 |
| `IFC` | 81 | 67 · 8 · 3 · 0 · 3 | 80 | 1 | 0 | 0 | 7 | 5 | 2 | 0 | 0 | 0 |
| `ISO` | 2 | 0 · 0 · 0 · 0 · 2 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `LOCAL` | 23 | 0 · 9 · 14 · 0 · 0 | 22 | 0 | 3 | 1 | 1 | 0 | 0 | 0 | 1 | 1 |
| `MDL` | 5 | 5 · 0 · 0 · 0 · 0 | 2 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 0 | 0 |
| `OPS` | 60 | 59 · 1 · 0 · 0 · 0 | 33 | 0 | 0 | 0 | 2 | 28 | 13 | 1 | 1 | 1 |
| `PROF` | 63 | 46 · 7 · 1 · 1 · 8 | 62 | 5 | 2 | 0 | 2 | 3 | 3 | 0 | 0 | 0 |
| `PROV` | 77 | 2 · 2 · 0 · 0 · 73 | 46 | 26 | 6 | 2 | 6 | 3 | 1 | 2 | 21 | 0 |
| `RUN` | 4 | 4 · 0 · 0 · 0 · 0 | 4 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `AGT` | 85 | 28 · 0 · 33 · 22 · 2 | 83 | 4 | 4 | 2 | 2 | 2 | 0 | 0 | 4 | 8 |
| `GATE` | 80 | 79 · 0 · 1 · 0 · 0 | 79 | 0 | 10 | 6 | 8 | 0 | 0 | 0 | 2 | 2 |
| `SPD` | 4 | 4 · 0 · 0 · 0 · 0 | 4 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| `VER` | 36 | 35 · 1 · 0 · 0 · 0 | 32 | 1 | 0 | 0 | 0 | 2 | 1 | 2 | 0 | 0 |

## Requirements

### Requirement lines

- **FD-VER-001** · phase 0 · `V-UNIT` — On every pull request and every push to the default branch, CI must run the `spec-tags` check over every `.md` file under `specs/` except `specs/adr/`, ignoring lines inside fenced code blocks.
- **FD-VER-002** · phase 0 · `V-UNIT` — If a line that starts with `- **FD-` does not match the requirement form `- **FD-<AREA>-NNN** · phase <0–4> · <tags> — <sentence>`, then the `spec-tags` check must fail naming the file and line.
- **FD-VER-003** · phase 0 · `V-UNIT` — If a requirement's sentence contains `must` and its tag list holds no tag, then the `spec-tags` check must fail naming the ID.
- **FD-VER-004** · phase 0 · `V-UNIT` — If a tag list holds a tag outside the ten tags of the tag table in [README.md](README.md), or holds one tag twice, then the `spec-tags` check must fail naming the ID and the tag.
- **FD-VER-005** · phase 0 · `V-UNIT` — If a requirement's area is not in the area table of [README.md](README.md), or the requirement sits in a file other than the one that table names for its area, then the `spec-tags` check must fail naming the ID and the file.
- **FD-VER-006** · phase 0 · `V-UNIT` — If an ID occurs as a requirement line more than once under `specs/`, or as a requirement line and as an `fd_id` of `specs/ids.moved.tsv`, then the `spec-tags` check must fail naming every occurrence.
- **FD-VER-007** · phase 0 · `V-UNIT` — If an ID that has a requirement line on the pull request's base commit has no requirement line on the head commit and no row in `specs/ids.moved.tsv`, then the `spec-tags` check must fail naming the ID.
- **FD-VER-008** · phase 0 · `V-UNIT` — If a reference of the form `FD-<AREA>-NNN` anywhere under `specs/` names an ID that has neither a requirement line nor a row in `specs/ids.moved.tsv`, then the `spec-tags` check must fail naming the file, the line and the ID.
- **FD-VER-034** · phase 0 · `V-UNIT` — If a row of `specs/ids.moved.tsv` does not hold exactly the columns `fd_id`, `disposition` and `target`, has a `disposition` other than `moved`, `profile`, `merged` and `removed`, or names an `fd_id` twice, then the `spec-tags` check must fail naming the row.
- **FD-VER-035** · phase 0 · `V-UNIT` — If a `moved` row of `specs/ids.moved.tsv` names a `MAMEKO-<AREA>-NNN` target that has no requirement line in mameko's specifications at the pinned commit, or a `profile` row names a target that has no requirement line in [profile.md](profile.md), then the `spec-tags` check must fail naming the row.
- **FD-VER-036** · phase 0 · `V-UNIT` — If a link into mameko's repository under `specs/` names a commit other than the one [README.md](README.md) pins, then the `spec-tags` check must fail naming the file and line.
- **FD-VER-037** · phase 0 · `V-UNIT` — If a requirement line on the head commit carries an ID with an `FD-<AREA>-NNN` number at or below the highest number its area has ever used, and that ID had no requirement line on the base commit, then the `spec-tags` check must fail naming the ID, so that a number is never reused.

### Coverage and traceability

- **FD-VER-009** · phase 0 · `V-UNIT` — The `spec-tags` check must compute the requirement count per area, phase and tag, and must fail if any count in the coverage tables of this file or in the phase tables of [roadmap.md](roadmap.md) differs from the computed count.
- **FD-VER-010** · phase 0 · `V-UNIT` — If an ID tagged `V-PROOF` is absent from the Requirements column of the formal property table, or an ID in that column does not carry `V-PROOF`, then the `spec-tags` check must fail naming the ID.
- **FD-VER-011** · phase 0 · `V-UNIT` — If an FD ID in the Assumption tests column of the formal property table carries neither `V-CONF` nor `V-SIM`, then the `spec-tags` check must fail naming the ID.
- **FD-VER-012** · phase 0 · `V-UNIT` — The `spec-tags` check must map each test title that contains `[FD-<AREA>-NNN]`, each Lean theorem whose docstring lists an ID and each Tamarin lemma whose comment lists an ID to that ID, under the tag of the harness directory the entry lives in, and must report per tag each requirement of the current phase or lower that has no entry.
- **FD-VER-013** · phase 0 · `V-UNIT` — If the formal property table marks a theorem or lemma *proved* and FlareDispatch's `formal/` holds no theorem or lemma of that name whose docstring or comment lists every requirement ID of its row, then the `spec-tags` check must fail naming the theorem.

### mameko conformance and the reference profile

- **FD-VER-032** · phase 1 · `V-CONF` — On every pull request, the `conf` job must run mameko's coordinator conformance suite, at the pinned release, against FlareDispatch's composed control plane: `host-cloudflare` under workerd with FlareDispatch's profile, its appliers on the fake GitHub, its application ports and the fake executor, and must fail on any scenario that fails ([MAMEKO-VER-022](https://github.com/fractalboxdev/mameko/blob/3af65c59d5f30123eb55b468966b4975c7395ece/specs/verification.md), [MAMEKO-VER-024](https://github.com/fractalboxdev/mameko/blob/3af65c59d5f30123eb55b468966b4975c7395ece/specs/verification.md)).
- **FD-VER-033** · phase 0 · `V-DEPLOY` — On every pull request, the `profile-reference` job must run the reference-profile comparison of [profile.md](profile.md) FD-PROF-002 at the pinned mameko commit, which fails only on a difference that profile.md § Differences from the reference CI profile does not list, and the job must fail when that comparison fails.

### Formal gate

- **FD-VER-014** · phase 0 · `V-UNIT` — On every pull request and every push to the default branch, the `formal` job must run `lake build` in `formal/` under the toolchain that `formal/lean-toolchain` pins to an exact version, and must fail on any build error.
- **FD-VER-015** · phase 0 · `V-UNIT` — If a `.lean` file in `formal/` contains `sorry`, `admit`, `native_decide` or an `axiom` declaration, then the `formal` job must fail naming the file and line.
- **FD-VER-016** · phase 0 · `V-UNIT` — If `#print axioms` for any theorem in `formal/` lists an axiom other than `propext`, `Classical.choice` and `Quot.sound`, then the `formal` job must fail naming the theorem and the axiom.
- **FD-VER-018** · phase 0 · `V-UNIT` — A `V-PROOF` requirement must count toward a phase gate only while its theorem or lemma passes the formal gate and every assumption test of its row in the formal property table passes on the same commit.

### Differential testing

- **FD-VER-019** · phase 0 · `V-UNIT` — On every pull request, the `diff` job must replay every line of `formal/regressions.jsonl` and then run 10,000 generated traces through `stagedWriteGate` and the oracle built from the same commit, and must fail on the first trace whose outputs differ.
- **FD-VER-020** · phase 0 · `V-UNIT` — Every night, CI must run 1,000,000 generated traces of `stagedWriteGate` against the oracle on the default branch's head commit.
- **FD-VER-021** · phase 0 · `V-UNIT` — When a trace differs, the `diff` job must shrink it and emit one JSON line holding the kernel, the seed, the shrunk trace and both outputs, and the nightly run must open a pull request that appends that line to `formal/regressions.jsonl`.
- **FD-VER-022** · phase 0 · `V-UNIT` — If a pull request removes or changes a line of `formal/regressions.jsonl`, then the `diff` job must fail.

### Merge gate

- **FD-VER-023** · phase 0 · `V-DEPLOY` — The default branch's ruleset must require the checks `lint`, `typecheck`, `spec-tags`, `unit`, `conf`, `sim`, `replay`, `e2e-local`, `deploy-dry-run`, `profile-reference`, `formal` and `diff`, and the drift check must fail if any of them is missing.
- **FD-VER-024** · phase 0 · `V-UNIT` — On every pull request, the `sim` job must run every `V-SIM` scenario with 100 seeds plus every seed in `test/sim/seeds.jsonl`, and the nightly run must run 10,000 seeds per scenario and append each failing seed to `test/sim/seeds.jsonl` through a pull request.
- **FD-VER-025** · phase 0 · `V-UNIT` — If a workflow's second run over its cached journal makes a GitHub call, a D1 write or an intent that its first run did not, then the `replay` job must fail naming the workflow and the extra effect.

### Phase gate

- **FD-VER-026** · phase 0 · `V-UNIT` — When a pull request changes `.github/phase` from n to n + 1, the `phase-gate` job must fail unless every requirement of phase n or lower has a passing harness entry for each of its tags other than `V-LIVE` and `V-MEASURE` on the pull request's base commit.
- **FD-VER-027** · phase 0 · `V-UNIT` — When a pull request changes `.github/phase` from n to n + 1, the `phase-gate` job must fail unless the nightly `conf`, `sim`, `e2e-local` and `diff` runs passed on the base commit or on a later nightly run.
- **FD-VER-028** · phase 0 · `V-UNIT` `V-MEASURE` — When a pull request changes `.github/phase` from n to n + 1, the `phase-gate` job must fail unless every `V-MEASURE` threshold of gate n in [roadmap.md](roadmap.md) holds over its window, read from the executions table of the control plane that this repository's deploy workflow targets.
- **FD-VER-029** · phase 0 · `V-UNIT` `V-LIVE` — When a pull request changes `.github/phase` from n to n + 1, the `phase-gate` job must fail if a page alarm of a `V-LIVE` requirement of phase n or lower stayed unresolved for more than 24 h within the gate window.
- **FD-VER-030** · phase 0 · `V-MEASURE` — If a kill line of [roadmap.md](roadmap.md) is crossed over its window, then the control plane must raise the `kill-line` notification naming the risk, the metric, its value and the threshold.
- **FD-VER-031** · phase 0 · `V-UNIT` — While a `kill-line` notification is unresolved, the `phase-gate` job must fail for every phase above the current one.

## Open items

- TODO(maintainer): pin the Tamarin prover version in `formal/` before FD-PROV-073 runs in CI.
- TODO(maintainer): choose the owned device that runs the nightly device-path `conf` and `e2e-local` harnesses, and the runner label CI uses to reach it.
