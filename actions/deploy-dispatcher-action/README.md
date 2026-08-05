# `deploy-dispatcher-action`

Composite GitHub Action that deploys the FlareDispatch dispatcher Worker into
your Cloudflare account using an **operator overlay**: you carry one file
(`wrangler.jsonc`) with your Worker name + R2/D1/KV ids + vars, and a 40-char
SHA that pins which upstream commit to deploy.

The action:

1. Checks out `fractalboxdev/flare-dispatch` at `inputs.upstream-ref`.
2. **Overwrites** that checkout's `wrangler.jsonc` with your `inputs.wrangler-config`.
3. `pnpm install --frozen-lockfile` in the upstream tree.
4. `wrangler d1 migrations apply <binding> --remote`.
5. `wrangler deploy`.
6. (Optional) Polls `inputs.health-check-url`'s `/health` with backoff.

Sibling to [`flare-dispatch-action`](../flare-dispatch-action/) — that one
**dispatches a run** from a consumer repo into a Worker; this one **ships the
Worker itself**.

---

## Why an overlay (not a fork)

Every BYOC deploy diverges from upstream by exactly the same fields — Worker
name, the Cloudflare-account-scoped R2 bucket / D1 / KV ids,
`CLOUDFLARE_ACCOUNT_ID` var, and (for the bedrock route) `AI_GATEWAY_ID`. A fork
to carry that is overhead: the only "diff" lives in `wrangler.jsonc`, and
bumping upstream becomes a rebase chore.

With the overlay you keep one file in your repo plus a single-line `UPSTREAM_SHA`
pin. Bumping upstream is a one-line PR with a `compare/<old>...<new>` URL in the
body — you read the upstream diff, merge, then run your deploy workflow.

---

## Usage

In your repo:

```
infra/flare-dispatch/
├── UPSTREAM_SHA       # 40-char hex commit SHA on fractalboxdev/flare-dispatch
└── wrangler.jsonc     # your operator overlay
```

`infra/flare-dispatch/wrangler.jsonc` (operator-owned) — start by copying
`wrangler.jsonc` from upstream at your pinned SHA and changing:

- `name` → your Worker name (e.g. `flare-dispatch-acme`)
- `vars.CLOUDFLARE_ACCOUNT_ID` → your account id
- `vars.AI_GATEWAY_ID` → your AI Gateway slug (only needed for the bedrock route)
- `r2_buckets[].bucket_name`
- `d1_databases[].database_id` and `database_name`
- `kv_namespaces[].id`

Workflow:

```yaml
# .github/workflows/deploy-flare-dispatch.yml
name: Deploy FlareDispatch
on:
  workflow_dispatch:

permissions:
  contents: read
  id-token: write # only if you pull CF creds via OIDC / Pulumi ESC

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - id: pin
        run: echo "sha=$(tr -d '[:space:]' < infra/flare-dispatch/UPSTREAM_SHA)" >> "$GITHUB_OUTPUT"

      - uses: fractalboxdev/flare-dispatch/actions/deploy-dispatcher-action@<sha>
        with:
          upstream-ref: ${{ steps.pin.outputs.sha }}
          wrangler-config: infra/flare-dispatch/wrangler.jsonc
          cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          cloudflare-account-id: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          health-check-url: https://flare-dispatch-acme.<your>.workers.dev/health
```

Pin the action itself by SHA (not `@main`) — same reason as the upstream pin.

---

## Worker secrets — out of band

The action does NOT touch Worker secrets. Set them once via `wrangler secret put`
(or rotate via your secret-rotation workflow):

| Secret                                             | Purpose                                                                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `HMAC_SECRET`                                      | Action-mode dispatch HMAC (matches `secrets.FLAREDISPATCH_HMAC` in consumer repos)                                                       |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`          | App auth — check-run callback + manifest install flow                                                                                    |
| `GITHUB_WEBHOOK_SECRET`                            | `POST /v1/webhooks/github` HMAC verify                                                                                                   |
| `ADMIN_TOKEN`                                      | `POST /v1/admin/events/:wf_id` bearer                                                                                                    |
| `LOG_LINK_SECRET`                                  | Signs the tokened log-viewer URLs (falls back to `HMAC_SECRET` when unset)                                                               |
| `OIDC_SIGNING_JWK`, `OIDC_ISSUER_URL`              | OIDC issuer (AWS STS federation, bedrock backend)                                                                                        |
| `BROWSER_CDP_CONNECT_URL`, `BROWSER_CDP_API_TOKEN` | Browser Rendering connect (`cdp-acceptance` only)                                                                                        |
| `AI_GATEWAY_AUTH_TOKEN`                            | Forwarded as `cf-aig-authorization: Bearer` on the bedrock route — required only when the AI Gateway has Authenticated Gateway turned on |

---

## Inputs

See [`action.yml`](./action.yml). The required ones:

| Input                   | What                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `upstream-ref`          | A commit SHA on upstream main. Almost always `$(cat infra/flare-dispatch/UPSTREAM_SHA)`. |
| `wrangler-config`       | Path to your overlay (relative to the consumer repo root).                               |
| `cloudflare-api-token`  | CF API token with the scopes `wrangler deploy` needs.                                    |
| `cloudflare-account-id` | 32-hex account id.                                                                       |

---

## Outputs

| Output         | What                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `upstream-sha` | The SHA the upstream was checked out at (echo it into your step summary if `upstream-ref` was a branch). |
| `worker-url`   | The URL from `health-check-url` after a successful 200 (empty when the check was skipped).               |

---

## Bumping upstream

```sh
gh api repos/fractalboxdev/flare-dispatch/commits/main --jq '.sha' \
  > infra/flare-dispatch/UPSTREAM_SHA
git checkout -b chore/bump-flare-dispatch-$(cut -c1-7 infra/flare-dispatch/UPSTREAM_SHA)
git commit infra/flare-dispatch/UPSTREAM_SHA -m "chore: bump flare-dispatch to $(cut -c1-7 infra/flare-dispatch/UPSTREAM_SHA)"
gh pr create --draft --title "..." \
  --body "Compare: https://github.com/fractalboxdev/flare-dispatch/compare/<old>...<new>"
# After review + merge:
gh workflow run deploy-flare-dispatch.yml
```
