# ADR-0019: Security gate, scan bundle, verdict records and scoped service identities

Status: Proposed · 2026-11-08

## Context

- The catalog has no recipe that answers "is this change safe to merge?" for dependencies, secrets and workflows. `pr-review` reports model findings, and its default `advisory` mode concludes `success` whatever it finds (FD-AGT-055).
- GitHub branch protection treats a `neutral` conclusion as passing ([ADR-0005](0005-qos-classes-queue-then-fail.md)). FD-GATE-017, FD-GATE-039 and FD-AGT-046 each conclude `neutral` for a whole class of pull requests, a `[bot]` author included.
- A scanner reads its configuration and suppressions from the checkout, and the pull-request author controls the checkout. Measured on gitleaks 8.30.1, zizmor 1.32.0 and OSV-Scanner 2.7.0 with no extra flags, a pull request that adds a suppression hides its own finding from each scanner: all three exit 0.
- `dispatchers` and `operators` are flat lists. A member of `dispatchers` may name any run on any repository, and `check` takes commands from dispatch inputs (FD-GATE-001). A member of `operators` holds `force-admit`, `top-up` and `revoke`. An automated caller that needs a narrow authority has no list to join.
- An organization's security policy changes on its own schedule, and that organization needs its CI to enforce the policy with no runtime dependency on the system that wrote it.
- mameko's terminal write inserts one kind, the outcome mapping's `surface_kind` ([outbox.md § Lifecycle intents](https://github.com/fractalboxdev/mameko/blob/045fe5c576aa79ade726e0a08c30eb6cbf02afd1/specs/outbox.md#lifecycle-intents)). A second kind declared `on: terminal` gets no row.

## Decision

- **Two recipes.** `security-gate` runs on `pull_request`, `merge_group` and check re-runs under the check name `flare-dispatch/security-gate`. It has no command input, no skip path and no dispatch trigger. `security-rescan` runs the same scan on a dispatch under the check name `flare-dispatch/security-rescan`, so a re-scan cannot replace a required result.
- **A signed scan bundle, pinned in the overlay.** The bundle holds the gitleaks rules, the zizmor configuration, the baseline checks, the accepted scanner versions, the exit maps and the suppression policy, in a DSSE envelope with a key history. `scan.bundleDigest` is an overlay value. The deploy verifies the signature and digest before any change, accepting a key only while its window contains the deploy-verification time; it makes no claim about historical signing time. Each run verifies the digest. A bad pin fails the deploy, so the running Worker keeps enforcing the previous pin.
- **Suppressions come from the target branch.** The recipe restores each suppression file from the base commit, removes suppression markers from the lines the pull request adds, and replaces each scanner's configuration file with the bundle's.
- **An offline advisory snapshot.** A daily ops run writes OSV's published archives to the deploying account's R2. A snapshot older than `scan.advisoryMaxAgeHours`, default 48, ends the scan `failure` with a `config:` reason.
- **Cloud executors only.** `security-gate` and `security-rescan` carry the `cloud-only` constraint, so a compromised device cannot report a passing scan.
- **`pr-review` stays advisory for security.** `Finding` gains `ruleId` and `fingerprint`. No catalog recipe gates a merge on a model's security opinion. A recipe that does so runs its security reviewer on every change class and concludes `failure` when that reviewer fails.
- **Verdict records.** `job.record` is generated `on: lease-granted`. `verdict.record` is an ops intent that the minute tick inserts for each terminal execution, because a second `on: terminal` kind gets no row. Each record is an HMAC-signed `POST` under the delivery key `records`, which a `containment` identity cannot pause.
- **Two scoped lists.** `dispatch.scoped` admits `{ identity, runs, repositories, classCeiling }` for read-only scan runs. `containment` admits `halt` to a tighter state, `quarantine`, `pause-key`, the delivery-key list, the executions list and `cancel`. Returning to `run`, `release`, `revoke` and `resume-key` stay with `operators`.
- **Phase 2.** The new requirements enter at phase 2, with the egress profiles and `pr-review` they build on.

## Options considered

| Option | Buys | Costs |
| --- | --- | --- |
| **A catalog recipe with fixed commands (chosen)** | One review of each invocation; a repo manifest cannot weaken it; works on install | A scanner upgrade needs an image publish |
| Scanners as `check` manifest commands | No new recipe | The manifest's author controls the flags, and `skipAuthors` still concludes `neutral`; lost on criterion 1 |
| **Digest pin in the overlay, verified at deploy (chosen)** | One valid bundle per deploy; the merge path has no dependency outside the account | A bundle change needs a reviewed overlay change and a deploy |
| Fetch the newest signed bundle at run time | Bundle changes apply in minutes | A bundle publisher outage blocks merges, and a compromised publisher reaches every run; lost on criterion 3 |
| **Offline advisory snapshot (chosen)** | `outbound` stays false, so a fork pull request on a private repository does not end `policy: trifecta` (FD-AGT-005); the digest makes a verdict reproducible | 209 MiB for the npm archive alone, and up to 48 h of advisory lag |
| OSV-Scanner online queries | Newest advisories; no storage | `outbound` becomes true for every run; lost on criterion 4 |
| **Restore suppressions from the base commit (chosen)** | A target-branch suppression keeps working and a head suppression does nothing | The recipe edits its checkout before each scan |
| `--no-ignores` and `--ignore-gitleaks-allow` for every scanner | One flag per scanner | zizmor's flag drops target-branch markers too, gitleaks reads a head `.gitleaksignore` whatever `--gitleaks-ignore-path` names, and OSV-Scanner has no such flag; lost on criterion 2 |
| **`verdict.record` as an ops intent from a sweep (chosen)** | Covers every terminal path, the settle sweep included, at the pinned mameko | Up to one tick of lag; a record is outside the terminal transaction |
| Let every `on: terminal` kind generate a row | A record in the terminal transaction | Needs a mameko change that does not exist at the pinned commit |
| `on: accepted` | In mameko today | Misses every outcome with no accepted result: `halt`, deadline, cancel and a lost execution; lost on criterion 5 |
| **Scoped lists (chosen)** | Each automated caller holds only its operations | Two more overlay values and more gate checks |
| Join `dispatchers` and `operators` | No new surface | A scan caller gains command execution, and a containment caller gains `force-admit` and `revoke`; lost on criterion 6 |
| A `cancel-all` route | One call | `halt-all` already stops every root below rank 0 ([MAMEKO-SPD-057](https://github.com/fractalboxdev/mameko/blob/045fe5c576aa79ade726e0a08c30eb6cbf02afd1/specs/spend.md)); only `release` remains, and the list and `cancel` routes reach it |

### Scanner behaviour

Measured on a fixture repository with a target branch and a pull-request branch. Each row is one invocation on macOS arm64 builds of gitleaks 8.30.1, zizmor 1.32.0 and OSV-Scanner 2.7.0; FD-GATE-114 repeats the suppression and exit behaviour on each published image.

| Input in the pull-request head | Invocation | Exit | Result |
| --- | --- | --- | --- |
| `.gitleaks.toml`, `gitleaks:allow` | `gitleaks git --log-opts=<range>` | 0 | Both secrets hidden |
| `.gitleaks.toml`, `gitleaks:allow` | plus `--config <bundle> --ignore-gitleaks-allow --exit-code 42` | 42 | Both secrets reported |
| `.gitleaksignore` | plus `--gitleaks-ignore-path <empty directory>` | 42 | That secret stays hidden; only the inline one is reported |
| `.gitleaksignore` removed from the checkout | as above | 42 | Both secrets reported |
| Malformed `--config` | `gitleaks git` | 1 | Tool error, distinct from 42 |
| Added and deleted within the range | `gitleaks git` | 42 | Secret reported |
| `.github/zizmor.yml`, `# zizmor: ignore[...]` | `zizmor <file>` | 0 | Hidden |
| The same | `zizmor --no-config --no-ignores .` | 14 | Head finding reported, and the target-branch marker dropped too |
| `# zizmor: ignore[...]` removed from the added line | `zizmor --config <bundle> .` | 14 | Head finding reported, and the target-branch marker kept |
| Missing `--config` file | `zizmor --config <file> .` | 1 | Tool error |
| `osv-scanner.toml` beside a lockfile, root or subdirectory | `osv-scanner scan source --offline-vulnerabilities -r .` | 0 at the root | That lockfile's vulnerabilities hidden |
| `.osv-scanner.toml` | as above | 1 | Not read |
| `osv-scanner.toml` removed from the checkout | as above | 1 | Reported |
| Missing database, or none for the lockfile's ecosystem | as above | 127 | Tool error; no pass |
| Malformed lockfile or `--config` | as above | 127 | Tool error |
| Lockfile with no packages, or no lockfile | as above | 128 | Nothing in scope |

zizmor documents exit codes 11 to 14 for findings by highest severity and 1 to 3 for errors. The fixture produced 0, 1 and 14; the others were not observed.

## Criteria

1. A repo manifest and a pull request cannot weaken the scan, and no path from a scan to `neutral` exists. This decided recipe against manifest commands.
2. A suppression in the pull-request head has no effect, and a suppression on the target branch keeps working. This decided the restore-and-strip mechanism.
3. A check's result depends on nothing outside the deploying account. This decided the overlay pin against a run-time fetch.
4. `outbound` stays false for a scan, so it runs on any repository and any fork. This decided offline data against online queries.
5. Every terminal outcome produces a record. This decided the sweep against `on: accepted`.
6. An automated caller holds only the operations its job needs. This decided scoped lists against joining the existing ones.

## Consequences

- Every enrolled repository depends on a fresh advisory snapshot: once a snapshot's `Last-Modified` time is older than `scan.advisoryMaxAgeHours` (default 48 h, so about one missed daily refresh), `security-gate` turns red on pull requests that change a lockfile and `advisory-snapshot-stale` pages.
- `zizmor.yml` and `.gitleaks.toml` on a target branch have no effect on a scan, because each scanner takes one configuration file and the bundle's replaces it. A repository suppresses through `.gitleaksignore`, `osv-scanner.toml` or a marker on a target-branch line.
- `flare-dispatch/security-gate` runs for dependabot and every other author, so a dependency bump with a known vulnerability reports `failure`.
- `check` keeps its `neutral` path for excluded authors, so a repository that requires `check` and accepts bot pull requests relies on `security-gate` for those pull requests.
- A required `pr-review` concludes `failure` for a bot author outside `prReview.reviewBots` (FD-AGT-093). Off the required set, `pr-review` keeps its `author-excluded` skip.
- `pr-review`'s `gating` mode stays available. It gates a merge on review quality, and the security merge check is `security-gate` in either mode.
- A check re-run of `security-gate` on the same commit runs the same scan under the same check name, and it may conclude differently after the bundle or the snapshot changes.
- A pause of an installation's delivery key leaves `check.open` and `check.conclude` pending, which blocks a merge on a check that has not concluded. A check that already concluded `success` stays mergeable.
- Bundle signing keys and their history become an operator duty.
- An expired or removed bundle key cannot authorize a new deploy, even of an envelope signed earlier. A new deploy needs a signature from a currently valid configured key; there is no historical-timestamp acceptance. Expiry does not replace an already-running pin or change the digest-only check that its runs perform.

## Revisit triggers

- mameko generates a row for every `on: terminal` kind: `verdict.record` moves into the terminal transaction.
- mameko offers an atomic delivery hold across keys: the containment hold and FD-INT-071 give way to it.
- Median advisory lag at a merge exceeds 24 h, or snapshots exceed 2 GiB per ecosystem.
- A scanner release changes a measured behaviour above: FD-GATE-114 fails its image, and the scanner table in [runs/gate.md](../runs/gate.md) changes with it.
