# ADR-0011: The sandbox SDK pin is a security surface

- **Status:** Proposed
- **Date:** 2026-08-06
- **Implementation:** `shipped` — the pin is exact in `apps/substrate/package.json` and both Dockerfiles, the canary (`src/verify/`) gates CI between the substrate and dispatcher deploys, and `container-config.test.ts` § "the pinned SDK pair (ADR-0011)" asserts both halves as literals: `@cloudflare/sandbox` against the manifest *and* the lockfile importer that resolved it, `@cloudflare/containers` by walking that importer's snapshot edge. A bump of either now fails a test, where the older assertion at `container-config.test.ts:109` catches only image/package skew. `@cloudflare/containers` remains **transitive** — declared in no `package.json` — and the repo still carries no renovate or dependabot config, which the Consequences below now state rather than claiming auto-bumps are "disabled".

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
  admitted. The probe is graded on its **HTTPS** leg. `interceptAllOutboundHttp` is registered
  unconditionally, so an http-only 520 proves the proxy is in the path for a protocol the engine
  refuses outright while saying nothing about the one every grant is written in; a deploy whose
  HTTPS probe cannot reach the proxy reaches no granted host and records no denial, and is not
  verified.
- Every bump of either package is a security-reviewed change to the substrate — never a routine dependency
  update — with the invariant checklist re-run: empty-allowlist interception engages; `interceptHttps`
  still routes HTTPS through `ContainerProxy.fetch` and the CA path is unchanged; `deniedHosts`
  holds against handler overrides; redirects are handler-policed.

## Consequences

- **A test holds the pin, because no auto-bump mechanism exists to disable.** `src/container-config.test.ts`
  § "the pinned SDK pair (ADR-0011)" asserts both **literal** versions, so neither package moves
  without editing a test that points back at the checklist above. The repo carries no Renovate or
  Dependabot configuration, and GitHub's config-free Dependabot security updates are off at the repo
  setting — so there is nothing to switch off, and a line claiming otherwise would read as a control
  in a security review without being one. Adopting a dependency bot means configuring it to refuse
  these two packages, and this line becomes that statement.
- `@cloudflare/containers` is a **transitive** dependency — the substrate declares only
  `@cloudflare/sandbox`, so the other half of the pair appears in no `package.json` in the repo. The
  test reaches it by walking `pnpm-lock.yaml`: the `apps/substrate` importer, the sandbox version it
  resolved, and that snapshot's `@cloudflare/containers` edge. Scanning the lockfile for the version
  string instead would be answered by any workspace member — `apps/dispatcher` and
  `packages/runtime-cf` resolve the same version through `@cloudflare/sandbox` 0.10.1 — and would
  stay green with the substrate's own dependency deleted.
- The pin is scoped to the substrate. `apps/dispatcher` and `packages/runtime-cf` run
  `@cloudflare/sandbox` 0.10.1 under no equivalent assertion; they do not carry the deny-all egress
  posture this record protects, so their bumps are ordinary dependency updates.
- The canary doubles as the BYOC health check that an org's deployed the substrate actually enforces the
  floor its version claims (see patch distribution in `specs/platform.md`).
- The container image is part of the pin, not a separate concern: the DO is the client and the image
  is the server for one protocol, so `infra/Dockerfile.substrate` carries its own `FROM` tag tracking
  this worker's `@cloudflare/sandbox` — the dispatcher's image stays on its own version.
- The image also carries half of HTTPS interception. `interceptHttps = true` on the DO class is
  inert unless the container trusts `/etc/cloudflare/certs/cloudflare-containers-ca.crt`, which
  exists only at runtime — so `infra/container-entrypoint.sh` installs it on every boot and both
  images run that wrapper in front of `/container-server/sandbox`. Neither half ships alone: the
  flag without the CA breaks TLS for everything in the container.
- Implemented as `POST /canary` (`src/verify/`), gating the dispatcher's deploy job and reported on
  `/health`, which answers 503 `unverified` until the running build has passed.
