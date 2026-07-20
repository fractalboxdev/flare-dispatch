# FlareDispatch run catalog

Starter runs shipped in `@fractalboxdev/flare-dispatch-runs`. The Dispatcher
registers them by name; Action mode dispatches via
[`flare-dispatch-action`](../actions/flare-dispatch-action/), webhook mode fires
from each run's `triggers`.

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

| Field | Default | Notes |
| --- | --- | --- |
| `repo` | required | `owner/name` |
| `sha` | required | commit to checkout |
| `command` | omit | shell command; webhook resolves `check.command:<repo>` |
| `install` | `false` | R2-cached dep install after clone |
| `image` | omit | container image override |
| `env` | omit | **non-sensitive only** — dispatch inputs are persisted |
| `secrets` | `[]` | Worker-secret **names** injected into the command env via `loadSecrets` (inline, never checkpointed) |
| `secretPrefix` | omit | deprecated / ignored — Worker bindings are bare names (kept for `offload-test` parity) |
| `timeoutSec` | `600` | `sandbox.exec` timeout |
| `failOnNonZeroExit` | `false` | Action default; webhook trigger sets `true` |

### Webhook behavior

- Event: `pull_request` (`opened` / `synchronize` / `reopened` / `ready_for_review`)
- Skips drafts and `dependabot[bot]`
- Idempotency key: `check:{repo_}:{sha12}`
- `failOnNonZeroExit: true` — the check-run is the only pass/fail signal

### Outputs

| Field | Notes |
| --- | --- |
| `exitCode` | `0` when skipped |
| `durationMs` | from checkpointed exec; `0` when skipped |
| `logUri` | signed R2 URL to `check.log` (30-day TTL, same as sibling runs); absent when skipped |
| `skippedReason` | `"not-configured"` when opted out |

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
