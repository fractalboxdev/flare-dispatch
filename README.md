<h1 align="center">FlareDispatch</h1>

<p align="center">Offload the expensive half of GitHub Actions onto Cloudflare.</p>

<p align="center"><a href="https://flare-dispatch.fractalbox.dev"><b>Documentation</b></a></p>

---

BYOC CI/CD that moves the heavy compute off GitHub Actions and onto a Cloudflare stack you own — Workflows for orchestration, Containers for execution, Browser Rendering for e2e, R2 for cache and artifacts. Trigger runs from GitHub Actions, the GitHub App webhook, or a cron schedule; runs take the expensive jobs — agentic code review, Playwright e2e, acceptance suites, matrix fan-outs, security scans.

Runs are typed Effect-TS programs — composable steps, tagged errors, exhaustive matching — not YAML, written against a layered DSL: capabilities → primitives → recipes. `wrangler deploy` into your own Cloudflare account; no multi-tenant SaaS.

**Logs.** Every GitHub check-run summary links the tokened log viewer on your dispatcher's origin, and the Access-gated dashboard at `GET /` lists recent executions with the same links. The full trail — summary link → Workflows step timeline → raw log artifacts — is documented in [Finding your logs](runs/README.md#finding-your-logs).

**Substrate.** The execution environment for agentic work — containers, admission, deny-all egress, metered model access — lives at [`apps/substrate`](apps/substrate/specs/platform.md) as its own worker, consumed by the dispatcher and by out-of-repo agents over a service binding. Consumer, maintainer and operator guides — plus the generated facade API reference — are under [`apps/docs/substrate`](apps/docs/substrate/README.md).
