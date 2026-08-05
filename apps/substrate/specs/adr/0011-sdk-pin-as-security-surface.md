# ADR-0011: The sandbox SDK pin is a security surface

- **Status:** Proposed
- **Date:** 2026-08-06

## Context

The deny-all posture depends on verified internals of pre-1.0 SDKs: `allowedHosts = []` engages
interception only because of how `@cloudflare/containers` tests its effective-allowlist state, and
fractalbot's egress engine cites the library by line. The consumer repos currently diverge —
`@cloudflare/sandbox` 0.12.4 (fractalbot) vs 0.10.1 (flare-dispatch), both on
`@cloudflare/containers` 0.3.7. A version bump that changes interception semantics fails toward
**open egress** — the worst direction — and would do so silently.

## Decision

- The substrate pins one reconciled `@cloudflare/sandbox` + `@cloudflare/containers` pair (initial target:
  0.12.4 / 0.3.7).
- The interception invariants are re-verified on the pinned pair and encoded as a **deploy-time
  canary probe**: a container fetch to an unlisted host must die (520) before consumer traffic is
  admitted.
- Every bump of either package is a security-reviewed change to the substrate — never a routine dependency
  update — with the invariant checklist re-run: empty-allowlist interception engages; `deniedHosts`
  holds against handler overrides; redirects are handler-policed.

## Consequences

- Renovate-style auto-bumps are disabled for these two packages.
- The canary doubles as the BYOC health check that an org's deployed the substrate actually enforces the
  floor its version claims (see patch distribution in `specs/platform.md`).
