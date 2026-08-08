# ADR-0002: The substrate lives inside the flare-dispatch monorepo, with no name of its own

- **Status:** Accepted
- **Date:** 2026-08-06
- **Implementation:** `shipped` — the placement holds, and the lint rule this record promises now exists: `.oxlintrc.json` runs `no-restricted-imports` repo-wide with `apps/substrate/**` exempted, so a new consumer tree is covered the day it appears rather than when someone remembers to list it. It restricts both routes in — a path into the substrate directory, and the workspace package `@fractalboxdev/flare-dispatch-substrate` plus its subpaths, which no path glob matches and which a `workspace:*` dependency makes the easier of the two. Static, `export *` and dynamic `import()` forms all fail `pnpm lint` with the contract package named; a type-position `typeof import(…)` does not, and crosses no runtime boundary. `src/facade-boundary.test.ts` holds the rule's shape so it cannot drift to `warn` or lose a route silently.

## Context

The substrate needs a home and an identity. The candidates: a hard module inside this repo (the
founding spec's reviewed recommendation), a standalone repo (briefly created, with a product-style
name), or a separately branded product. The facade contract is young and will churn hardest during
the carve — exactly when cross-repo publish → pin-bump → adapt cycles cost the most — and the BYOC
deploy already ships dispatcher and substrate from one upstream pin in one action run.

## Decision

The substrate is a **component of the flare-dispatch monorepo**: the worker at `apps/substrate`
(wrangler name `flare-dispatch-substrate`, frozen at the first BYOC deploy) and the facade contract
at `packages/substrate-contract`, published so out-of-repo consumers can pin it. It carries **no
product name of its own** — in prose it is "the flare-dispatch substrate". The briefly-created
standalone repo and its naming ADR are retired.

Out-of-repo consumers depend on two artifacts, neither of which requires this repo: the **deployed
worker**, reached by an account-level service binding to `flare-dispatch-substrate`, and the
**published contract package**. fractalbot is the first such consumer. The substrate deploys
independently of the dispatcher — a substrate-only deploy job and per-component tags — so a
security patch or a consumer-driven substrate release never queues behind a dispatcher release,
and an org that wants the substrate without CI simply deploys this worker alone.

## Consequences

- Contract iterations during the carve are atomic PRs; the facade freeze can happen on evidence
  rather than on publish-cycle pressure.
- One `UPSTREAM_SHA` covers both workers for BYOC orgs; a security release is one tag.
- The facade boundary is enforced by workspace mechanics, not geography: consumers (the dispatcher
  included) import only `packages/substrate-contract`; a lint rule forbids imports from substrate
  internals; the SDK's unfenced exec is never exported (ADR-0003).
- Standalone extraction remains a topology change reserved for a promotion tripwire (an external
  consumer or paid demand for the execution environment alone) — `apps/substrate` +
  `packages/substrate-contract` lift out with history. Branding it is that day's decision, not
  today's.
- The fold counter-tripwire stands: if Cloudflare ships first-party equivalents of the policy
  delta, the substrate thins toward the SDK in place.
