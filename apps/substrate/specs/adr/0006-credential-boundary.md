# ADR-0006: No long-lived credential reachable from inside a container

- **Status:** Proposed
- **Date:** 2026-08-06

## Context

flare-dispatch injects secret values into the command env with best-effort substring redaction
(6 of ~19 catalog runs take a `secrets` input; `wrangler deploy` needs `CLOUDFLARE_API_TOKEN`), and
embeds GitHub installation tokens in clone URLs that survive in `.git/config`. fractalbot's ADR-0005
designed credential injection but never built it. Meanwhile the platform caught up: Cloudflare
Sandboxes' outbound handlers can inject credentials Worker-side so "the secret lives in the Worker's
environment and is never passed into the sandbox" — the machinery exists first-party; the substrate's job
is deciding *which* credential attaches under *which* grant. flare-dispatch's writeback path already
embodies the target: the Worker, never the container, performs the authenticated write.

## Decision

No long-lived credential is reachable from inside a container — env, argv, or filesystem. Writes
leave by two sanctioned shapes:

1. **Worker-side writeback** (preferred): the sandbox produces an artifact; the substrate or the consumer's
   Worker performs the authenticated write.
2. **Handler-injected credentials** for in-sandbox writes that cannot writeback (`wrangler deploy` →
   `api.cloudflare.com` is the acceptance case): credentials are per-host descriptors
   `{secretName, host, headerTemplate}` in the run/recipe definition; the substrate resolves the value and
   injects it in the egress handler on requests that pass the grant, strips container-authored auth
   headers, and hands the container nothing (or an inert placeholder for tools that refuse to start
   without one).

The **one sanctioned in-container credential** is the per-execution model-proxy token:
execution-scoped, budget-capped, header-only transport (query-param rejected), revoked by a DO alarm
at the run's max wall-clock — revocation does not depend on finalize running — and never logged.

## Consequences

- The rule takes effect per credential class as its shape lands; a migration table (GitHub App
  token, `CLOUDFLARE_API_TOKEN`, npm token, operator secrets) tracks each. The `secrets` /
  `secretPrefix` run inputs are deprecated at adoption and removed at stage-2 exit.
- Clone URLs are scrubbed from git remotes immediately post-clone; `.git` config is redacted at the
  artifact/checkpoint capture chokepoint.
- The substrate's never-store/never-log list: consumer bot tokens (never reach the substrate), installation
  tokens, secret values, capability-token values, raw prompts beyond metering metadata.
