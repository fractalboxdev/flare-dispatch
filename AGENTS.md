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

| Concern           | Cloudflare service |
| ----------------- | ------------------ |
| Orchestration     | Workflows          |
| Job execution     | Containers         |
| Browser / e2e     | Browser Rendering  |
| Cache + artifacts | R2                 |

### Triggers

A run can be started from three sources:

- **GitHub Actions** — a workflow step dispatches to FlareDispatch.
- **GitHub App webhook** — repo events trigger runs directly.
- **Cron schedule** — time-based runs.

## Deployment model

Single-tenant BYOC — no multi-tenant SaaS. Deploy with `wrangler deploy` into your own Cloudflare account. Default deploy domain: `flare-dispatch.fractalbox.dev`.

## Conventions

Effect-TS is the core programming model here — follow the Effect-TS rules in the workspace instructions (`Match`/`catchTag` over `._tag`, `Schema.TaggedError` over `throw`, generators over `.flatMap` chains, Layer composition). Prefer `wrangler` CLI over the Cloudflare dashboard for all Cloudflare state changes so infra stays in git and replayable.

### A `die` belongs in a deferred Layer, never in a live one

`RunContext` is the union of every capability service, so each Tag needs a Layer method whether or not this deploy can back it. That makes it easy to satisfy the compiler with `Effect.die("not implemented")` — and where you put that decides whether it is honest or lethal.

- **Deferred / no-op Layer — a `die` is honest.** The Layer is *selected* by "this deploy has no such binding", so the operator has already been told. `config.get` on a deploy with no `CONFIG_KV` dying loudly beats it returning `undefined` and letting a run mis-behave quietly.
- **Live Layer — a `die` is a landmine.** The Layer is selected because the deploy *is* configured, so the caller has every reason to expect it works. It type-checks, it reviews clean, and it takes the run down the first time anything reaches for it. Whoever finds it finds it in production.

So in a live Layer, an unbuildable method has three honest endings — **implement it, delete it from the service interface, or degrade it** — and never a `die`. Prefer deleting when nothing calls it: a capability nobody can use safely is not a capability, and *implemented reads as wired* to the next person who opens the interface. Add it back at the moment a caller exists, so the authority gets reviewed when it is real rather than in advance.

Degrade only where the degraded answer cannot be mistaken for data. A *write* may degrade to a logged no-op — reporting must not fail an otherwise-green run, which is why `github.pullReview` and `createRelease` log and continue on an uncredentialed deploy. A *read* whose empty answer would be read as a fact must fail instead: a PR-history read answering `[]` uncredentialed is indistinguishable from "never proposed", and a suppression check would then decide on a lie.
