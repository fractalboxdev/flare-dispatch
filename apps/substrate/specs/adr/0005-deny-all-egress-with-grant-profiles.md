# ADR-0005: Deny-all egress with named grant profiles

- **Status:** Proposed
- **Date:** 2026-08-06

## Context

fractalbot's egress engine (its ADR-0005; `src/egress.ts`, `src/exec.ts`) is the reviewed
implementation: deny-all class state arming interception, request-level policy (method/path/body
asserted against inputs no model authored), redirect re-policing with `redirect:"manual"`, an
admitted-set == handled-set invariant, kill-before-revoke. It is portable (zero Cloudflare imports)
but must live where the containers live — interception is a property of the container-owning worker
and cannot be layered on from outside. Its grant vocabulary, however, is public-read-one-repo only,
and it is authored per host. flare-dispatch's ~20 runs need egress the vocabulary cannot express
(npm/pypi registries, Playwright browser downloads, `api.cloudflare.com`, dynamic e2e targets), and
a grant derived from dispatch inputs would be attacker-influenceable — a hostile payload steering
the allowlist defeats deny-all. Denials today are undiagnosable from outside: unlisted hosts die as
bodyless 520s before any handler runs.

## Decision

- The substrate hosts the engine; deny-all is the floor for every workload, CI included.
- Consumers declare network needs as **named grant profiles** maintained and security-reviewed in
  the substrate — `public-repo-read`, `js-install`, `rust-install`, `browser-fetch`, `cf-api`,
  `github-api-read` — composed per run/recipe. Grants derive exclusively from definitions frozen in
  reviewed code; a dispatch payload may select among pre-authored grants, never define one. Dynamic
  targets declare a target schema (allowed host pattern + scheme) in the definition; an input host
  outside the pattern fails the dispatch, not the policy.
- Every denial — platform 520s and handler 403s — is recorded as a per-execution denial event
  `{host, method, path, reason, count}`, retrievable with the execution's artifacts, never surfaced
  into the container (oracle resistance).
- Rollout is a three-position per-run flag: `legacy` → `report` (legacy posture, would-be denials
  recorded — the grant-authoring loop) → `enforce`; a run graduates only after a clean report window.

## Consequences

- One audited egress surface; flare-dispatch's secrets-in-env posture ends (ADR-0006 carries the
  credential half).
- Accepted residuals, inherited and documented: DNS exfiltration uncovered; double-forked children
  survive `killAllProcesses`; `git-upload-pack` is a bounded exfiltration sink.
- Whether BYOC operators may author custom profiles, and behind what review gate, is deliberately
  open — it becomes the primary trust boundary if the substrate is ever consumed outside FractalBox.
