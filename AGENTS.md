# FlareDispatch

BYOC CI/CD that offloads the expensive half of GitHub Actions onto a Cloudflare stack you own. Heavy jobs — agentic code review, Playwright e2e, acceptance suites, matrix fan-outs, security scans — run on Cloudflare instead of GitHub-hosted runners.

## Status

Early-stage repo. Only `LICENSE` and `README.md` are committed — no application scaffolding, `package.json`, `wrangler` config, or source yet. There are no build/lint/test commands to run at this stage; add them here as the toolchain lands.

## Architecture (intended)

Runs are **typed Effect-TS programs**, not YAML — composable steps, tagged errors, exhaustive matching — written against a layered DSL:

- **capabilities** → the lowest layer: typed wrappers over Cloudflare primitives (Workflows, Containers, Browser Rendering, R2).
- **primitives** → reusable building blocks composed from capabilities (a build step, a test step, a cache read/write).
- **recipes** → complete, named run definitions composed from primitives (e.g. "Playwright e2e", "acceptance suite").

### Cloudflare component mapping

| Concern | Cloudflare service |
| --- | --- |
| Orchestration | Workflows |
| Job execution | Containers |
| Browser / e2e | Browser Rendering |
| Cache + artifacts | R2 |

### Triggers

A run can be started from three sources:

- **GitHub Actions** — a workflow step dispatches to FlareDispatch.
- **GitHub App webhook** — repo events trigger runs directly.
- **Cron schedule** — time-based runs.

## Deployment model

Single-tenant BYOC — no multi-tenant SaaS. Deploy with `wrangler deploy` into your own Cloudflare account. Default deploy domain: `flare-dispatch.openhackers.club`.

## Conventions

Effect-TS is the core programming model here — follow the Effect-TS rules in the workspace instructions (`Match`/`catchTag` over `._tag`, `Schema.TaggedError` over `throw`, generators over `.flatMap` chains, Layer composition). Prefer `wrangler` CLI over the Cloudflare dashboard for all Cloudflare state changes so infra stays in git and replayable.
