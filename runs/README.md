# FlareDispatch run catalog

Starter runs shipped in `@fractalboxdev/flare-dispatch-runs`. The Dispatcher
registers them by name; Action mode dispatches via
[`flare-dispatch-action`](../actions/flare-dispatch-action/), webhook mode fires
from each run's `triggers`.

## Finding your logs

Three layers, closest first:

1. **The check-run summary** (PR → Checks tab). Every check-run — in-progress
   and completed, green and red, on every dispatch path — carries up to two
   links: **"view full logs ↗"** opens the readable log viewer
   (`<origin>/logs/<instance-id>?t=<token>`; the token is signed with
   `LOG_LINK_SECRET`, falling back to `HMAC_SECRET`, and the link is omitted
   when neither secret is set), and **"view step logs in Cloudflare ↗"** opens
   the Workflows instance page (present only when `CLOUDFLARE_ACCOUNT_ID` is
   set, and needs dashboard access to your account). The dispatcher's own
   dashboard at `GET /` (Cloudflare Access-gated) lists recent executions with
   the same tokened viewer links — the browse path when you don't have the PR
   open. Cron-scheduled runs have no request to infer an origin from, so their
   viewer links need the `PUBLIC_ORIGIN` var.
2. **The Workflows step timeline.** The instance id is the semantic key with
   disallowed chars mapped to `_`, e.g. `check_owner_repo_<sha12>`:

   ```bash
   wrangler workflows instances describe runs-workflow check_owner_repo_<sha12>
   ```

3. **Raw artifacts** at `GET <origin>/v1/artifacts/<instance-id>/<name>`. The
   captured command log is a normal artifact; the name is per run — `check` →
   `check.log`, `offload-test` / `worker-deploy` → `step.log`, `oxlint` →
   `oxlint.log`, `playwright-demo` → `playwright.log`.

A command's log is uploaded **after** the command completes — a run killed
mid-command (timeout at the Workflow layer, container eviction) leaves no log
artifact behind. For `offload-test`, per-stage exec steps
([#82](https://github.com/fractalboxdev/flare-dispatch/pull/82)) split the run
into `step-<label>.log` uploads so earlier stages' logs survive a later stage's
death.

## `check` — universal command gate (opt-out by default)

Configurable PR gate for repos that do **not** want the hardcoded Oxc/`oxlint`
run. Clone → run one operator-supplied command → upload log → green/red
`flare-dispatch/check`.

Use this for `pnpm lint`, `npx eslint .`, `npx biome check .`,
`cargo clippy --workspace`, `ruff check`, etc.

Prefer [`oxlint`](./oxlint.ts) when you want the install-free Oxc gate with no
per-repo opt-in.

### Opt-in (required for webhook mode)

Absent a command, the run **no-ops green** with `skippedReason: "not-configured"`
— no clone, no container burn. There is no dispatcher-wide default command
(unlike `offload-test`).

```bash
wrangler kv key put --binding=CONFIG_KV \
  "check.command:owner/repo" "pnpm lint"
```

Do **not** require `flare-dispatch/check` in branch protection until that key is
set — an unconfigured skip would otherwise satisfy the required check.

### Several gates on one repo

A repo usually has more than one deterministic check worth requiring — a source
guard, `shellcheck`, a codegen-drift check. Dispatch `check` once per gate with
a distinct `checkLabel`; each lands as its own check-run
(`flare-dispatch/check:<label>`) and is separately requirable in branch
protection. Without a label they would all be named `flare-dispatch/check`,
which branch protection cannot tell apart.

```bash
wrangler kv key put --binding=CONFIG_KV \
  "check.command:owner/repo:lint-shell" "shellcheck scripts/*.sh"
wrangler kv key put --binding=CONFIG_KV \
  "check.command:owner/repo:codegen" "pnpm generate && git diff --exit-code"
```

A labelled dispatch reads `check.command:<repo>:<label>` and falls back to
`check.command:<repo>`, so adding a second gate never requires re-keying the
first. The fallback does not run in reverse: an **unlabelled** dispatch reads
only `check.command:<repo>`, so configuring a labelled gate never silently opts
the webhook-triggered default gate in.

The webhook trigger fires the unlabelled gate only — a trigger's `inputs`
callback is sync and payload-only, so it cannot enumerate a repo's labels from
KV. Labelled gates are dispatched Action-mode, one step per gate.

### Action mode

Pass `command` in the dispatch body (skips KV). Set `install: true` when the
command needs `node_modules` / a lockfile install.

```yaml
- uses: fractalboxdev/flare-dispatch/actions/flare-dispatch-action@<sha>
  with:
    run: check
    endpoint: ${{ vars.FLAREDISPATCH_ENDPOINT }}
    hmac-secret: ${{ secrets.FLAREDISPATCH_HMAC }}
    inputs: |
      {
        "repo": "${{ github.repository }}",
        "sha": "${{ github.sha }}",
        "command": "pnpm lint",
        "install": true,
        "failOnNonZeroExit": true
      }
```

### Inputs

| Field               | Default  | Notes                                                                                                |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `repo`              | required | `owner/name`                                                                                         |
| `sha`               | required | commit to checkout                                                                                   |
| `command`           | omit     | shell command; webhook resolves `check.command:<repo>`                                               |
| `checkLabel`        | omit     | names a second/third gate — see _Several gates on one repo_. `[A-Za-z0-9][A-Za-z0-9._-]{0,31}`       |
| `install`           | `false`  | R2-cached dep install after clone                                                                    |
| `image`             | omit     | container image override                                                                             |
| `env`               | omit     | **non-sensitive only** — dispatch inputs are persisted                                               |
| `secrets`           | `[]`     | Worker-secret **names** injected into the command env via `loadSecrets` (inline, never checkpointed) |
| `secretPrefix`      | omit     | deprecated / ignored — Worker bindings are bare names (kept for `offload-test` parity)               |
| `timeoutSec`        | `600`    | `sandbox.exec` timeout                                                                               |
| `failOnNonZeroExit` | `false`  | Action default; webhook trigger sets `true`                                                          |

### Webhook behavior

- Event: `pull_request` (`opened` / `synchronize` / `reopened` / `ready_for_review`)
- Skips drafts and `dependabot[bot]`
- Idempotency key: `check:{repo_}:{sha12}`
- `failOnNonZeroExit: true` — the check-run is the only pass/fail signal

### Outputs

| Field           | Notes                                                                                |
| --------------- | ------------------------------------------------------------------------------------ |
| `exitCode`      | `0` when skipped                                                                     |
| `durationMs`    | from checkpointed exec; `0` when skipped                                             |
| `logUri`        | signed R2 URL to `check.log` (30-day TTL, same as sibling runs); absent when skipped |
| `skippedReason` | `"not-configured"` when opted out                                                    |

### Secrets and logs

- Name credentials in `secrets` (e.g. `["NPM_TOKEN"]`). Values come from Worker
  secrets (`wrangler secret put NPM_TOKEN`) via `loadSecrets` — resolved
  **inline**, before the container is even provisioned, so a missing secret
  fails fast and plaintext never lands in a Workflow checkpoint. Per-dispatch
  `env` wins over a same-named secret.
- Do **not** put credentials in `env` or the command string — dispatch inputs
  and Workflow params are persisted.
- **Trust boundary**: the `pull_request` webhook trigger never carries
  `secrets` (hard-coded empty, no per-repo CONFIG_KV fallback) — a fork PR can
  never trigger a secret-bearing dispatch on its own. `secrets` only reaches
  the command via an explicit **Action-mode** dispatch that your own CI
  controls. That command still runs against the caller-selected `sha`, so —
  same guidance GitHub gives for `pull_request_target` + secrets — do **not**
  wire an Action-mode `check` dispatch with `secrets` into a workflow that
  triggers on `pull_request` for a repo that accepts external/fork PRs.
- Stdout/stderr land in `check.log` behind a signed URL (catalog-wide 30-day
  TTL). Every resolved secret **value** is scrubbed from that log (and from
  the inline preview) before upload as defense in depth — but this is a
  substring redaction, not a guarantee: a command that re-encodes a credential
  (base64, split across lines, etc.) before printing it can still leak it. Do
  not print tokens or personal data from the check command.

```yaml
# Action mode — private registry / authenticated tool. Only wire this into a
# workflow trigger you trust with the named secret (see trust boundary above).
- uses: fractalboxdev/flare-dispatch/actions/flare-dispatch-action@<sha>
  with:
    run: check
    endpoint: ${{ vars.FLAREDISPATCH_ENDPOINT }}
    hmac-secret: ${{ secrets.FLAREDISPATCH_HMAC }}
    inputs: |
      {
        "repo": "${{ github.repository }}",
        "sha": "${{ github.sha }}",
        "command": "pnpm lint",
        "install": true,
        "secrets": ["NPM_TOKEN"],
        "failOnNonZeroExit": true
      }
```

## `offload-test` — webhook mode needs two CONFIG_KV keys to run a real suite

`offload-test`'s `pull_request` trigger can only pass what it computes from the
PR payload, so a webhook dispatch historically ran with `install: false` and the
600s default timeout. That is fine for a source-only command and unusable for
the case the run exists to serve — a repo's actual test suite, which needs its
dependency tree and routinely outruns ten minutes.

Both are now resolvable per repo. They are a pair: a suite that needs an install
almost always needs the longer ceiling too.

```bash
wrangler kv key put --binding=CONFIG_KV \
  "offload-test.command:owner/repo"    "pnpm -r --if-present test"
wrangler kv key put --binding=CONFIG_KV \
  "offload-test.install:owner/repo"    "true"     # "true"/"1" | "false"/"0"
wrangler kv key put --binding=CONFIG_KV \
  "offload-test.timeoutSec:owner/repo" "1800"     # positive integer
```

Precedence is dispatch value → CONFIG_KV → default (`install: false`,
`timeoutSec: 600`). An Action-mode dispatch that passes a value always wins, and
one that passes `command` skips the config read entirely.

A malformed value degrades to the default rather than propagating: a non-integer
timeout would otherwise reach `sandbox.exec` as `NaN` — a timeout that never
fires, i.e. a hung run holding a container indefinitely.

`timeoutSec` is enforced per exec by the sandbox's own deadline. The run's
`maxDurationSec` (1800) is validated at definition time only — it is not a
runtime kill.

### Staged mode (`offload-test.stages:<repo>`)

One long buffered exec killed by the platform takes its whole log with it
(issue #39). Three more rungs split the webhook-mode run into one exec step per
stage, each uploading its `step-<label>.log` immediately, so a later stage's
death cannot orphan an earlier stage's log:

```bash
wrangler kv key put --binding=CONFIG_KV \
  "offload-test.stages:owner/repo"                "workspace,features,ts"
wrangler kv key put --binding=CONFIG_KV \
  "offload-test.command:owner/repo:features"      "pnpm test --filter features"
wrangler kv key put --binding=CONFIG_KV \
  "offload-test.timeoutSec:owner/repo:ts"         "900"
```

- `offload-test.stages:<repo>` — comma-separated stage labels
  (`[A-Za-z0-9][A-Za-z0-9._-]{0,31}` each). Absent → the single-exec behaviour,
  byte-identical. Present but malformed/empty/duplicated → the run fails loudly
  (a silent un-staging would resurrect the log-dies-with-the-step defect).
- `offload-test.command:<repo>:<label>` — per-stage command, falling back to
  the unlabelled `offload-test.command:<repo>` (the fallback is warned and
  flagged on the stage's step metadata). Two stages may share a command — a
  repo staging one command purely for the per-stage timeout and log split is
  a legitimate config, and the facade keys an exec's identity on the enclosing
  step as well as the command, so the stages stay distinct executions.
- `offload-test.timeoutSec:<repo>:<label>` — per-stage exec ceiling.

Per-stage timeout precedence: labelled rung → dispatch `timeoutSec` →
unlabelled rung → default (600). The labelled rung outranks the dispatch value
— an inversion of the usual dispatch-wins rule — because staged mode only
exists when the dispatch omitted `command` (webhook mode), so a `timeoutSec`
riding such a dispatch is a coarse whole-run knob, and the stage-specific key
is the more specific source.

Staging makes earlier stages' logs durable; it does not give a long suite more
wall time. Each stage still runs under its own exec ceiling, and those per-exec
ceilings are the only runtime enforcement — size them to the suite.

Staged mode is webhook-only: a dispatch that passes `command` skips the config
read and stays single-exec. Stages run inside one workflow instance posting one
check-run — sequentially by default, concurrently when the next rung says so.

### A stage does not assume its checkout

Container disk is ephemeral, and a staged run spanning forty minutes of durable
steps is long enough for the instance behind it to be recycled. The runtime
reports that as `working directory '<dir>' was missing at exec time — the
checkout did not survive to this step (container recycled)`, raised as
`ExecFailed`.

`ExecFailed` is exactly what `retryOn` retries, so the platform re-ran the same
command in the same missing directory three times and reported a failure about a
missing directory rather than anything about the code. The retry could never
have worked: the thing it needed was the thing that was gone.

So **every** PR run and every path within it — `offload-test` staged and
single-exec, `check`, and `oxlint` — calls the `ensureWorkspace` primitive
inside its retryable step: it
probes `test -d <dir>/.git` and re-clones when the probe fails. On the happy path
that is one extra exec of about a second; on a recycled container it is a clone
and an install, which is what the step was going to need anyway.

Isolated stages need no probe: they acquire a workspace inside the retryable
step already, so a retry rebuilds it by construction.

### Isolated stages (`offload-test.stageConcurrency:<repo>`)

```bash
wrangler kv key put --binding=CONFIG_KV \
  "offload-test.stageConcurrency:owner/repo"      "4"
```

Absent or `1` is the shared-container sequential mode above, byte for byte.
Above 1, each stage acquires its **own** container — `acquire({ key: <label> })`
— and up to N run at once.

The key is what makes that true. Until the runtime routed by the handle, a
second `acquire` returned the execution's one container and the stages raced to
wipe each other's checkout (`git clone` clears its target directory first): five
stages, five `CheckoutFailed`s, in under five seconds. Each keyed container is
destroyed as its stage finishes rather than idling out `sleepAfter` — the
dispatcher's end-of-run teardown owns the execution's own id and cannot know
what a run named.

**Not available on the substrate backend**, which namespaces one sandbox per
consumer execution. `acquire({ key })` there fails `ContainerLaunchFailed`
rather than quietly handing back the first container, because quietly handing it
back is the defect this option exists to fix.

The reason is the retry, not the speed. A stage step carries `retries: 3` on
`ExecFailed`, and with a shared container that guarantee is empty: container
disk is ephemeral, so when an instance dies the next one starts with no
checkout, and the retry re-runs the command against a directory that no longer
exists — failing in seconds for a reason unrelated to the original, which is
what the run then reports. Isolated, the retryable step is
`workspace` + `exec` as one unit, so a retry re-acquires, re-clones and
re-installs before running the command. A retry whose precondition the failure
destroyed is not a retry.

Two semantics follow from independence rather than from choice:

- **Every stage runs.** Sequential mode stops at the first red because later
  stages share its container and are treated as dependents; isolated stages have
  no such relationship, and stopping would discard results already paid for. All
  of them report, and the run fails if any failed. No `⊘ skipped` line can
  appear.
- **Each stage pays its own checkout and `install`.** On a repo whose install is
  a large cold download that is N times the bytes — overlapping in time, so it
  costs bandwidth rather than wall clock.

Use it when the stages are independent (different feature unifications of one
tree, say). Leave it at 1 when a later stage consumes an earlier one's output,
which sharing a container is the only way to express. A value above the stage
count is clamped to it.
