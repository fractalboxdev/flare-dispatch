# ADR-0010: Named image classes, selected by policy — never by the model or the payload

- **Status:** Proposed
- **Date:** 2026-08-06

## Context

Cloudflare requires a distinct Durable Object class per container image; every image must exist at
deploy time as a class in the `containers` config — there is no runtime image composition.
flare-dispatch's planned `RequiredCapabilities` image planning is design-doc only (zero code hits),
so any "declare what you need" scheme can only ever select among baked classes. Separately,
fractalbot's ADR-0013 established the invariant the substrate must inherit before its isolate tier ever
lands: an execution backend the model can name is an egress posture the model can choose.

That invariant holds; the containment claim under it does not. Dynamic Workers carry their own
egress control — `globalOutbound` intercepts every `fetch()` and `connect()` a dynamic Worker makes:
`null` isolates it entirely (both throw), and a `WorkerEntrypoint` gateway routes every call through
consumer code, which is the same shape as this substrate's outbound handler one tier down. So an
isolate tier is containable, and "isolates escape every control" is not the reason to defer it. The
requirement is narrower and testable: the tier lands only on a surface whose outbound is disabled by
default and re-opened through a grant, or it does not land.

## Decision

- The substrate ships **named image classes**: `lean`, `browser`, `agent` (from flare-dispatch) and `task`
  (fractalbot's image — OpenCode harness, git-lfs, CA bundle) as a fourth class. One admission pool
  per class (ADR-0004).
- Image class and execution tier are **policy-selected** from the recipe/run definition before any
  tool is offered to a model; neither is model- or payload-visible.
- The class taxonomy stays out of the public facade contract, so capability-based planning can
  arrive later as a selection function over the same named classes without consumers noticing.
- The two halves of that invariant are owned in different places, and this ADR says which:
  **payload-visibility is the substrate's** and is enforced here; **model-visibility is the
  consumer's**, because the substrate has no model-facing surface — the tool a model sees is the
  consumer's own (`sandbox_exec`), and nothing in this repo can assert its schema. A consumer
  adopting the facade owes a test that its exec tool's input schema names no pool, image, backend or
  tier field. fractalbot satisfies this today: its `sandbox_exec` declares one property, `command`,
  with `additionalProperties: false`.

## Consequences

- The `task` class builds from its own `infra/Dockerfile.task`, not another `image_vars` branch of
  the shared file. The base tag is half of [ADR-0011](0011-sdk-pin-as-security-surface.md)'s pinned
  pair — the SDK speaks HTTP/RPC to a server baked into the image — and the two workers' pins
  differ: this one runs `@cloudflare/sandbox` 0.12.4, the dispatcher 0.10.1. What it bakes is now
  flare-dispatch's own requirement, stated once in that file: OpenCode as the harness CLI, git-lfs,
  CPython 3.11 with a working `venv`, pnpm, ripgrep, a native toolchain, and the CA bundle as env
  so an intercepted request validates against the store the runtime writes to rather than each
  tool's vendored roots. No consumer names any of it.
- Two of those are decisions rather than installs, and both follow from deny-all. git-lfs ships as a
  binary with **no** system smudge filter, so a clone reaches for LFS objects only under a recipe
  that opened the grant for them; a filter would fail every unasked-for LFS checkout on a denied
  fetch. pnpm is installed globally rather than behind a corepack shim, which resolves the
  repository's pinned version by downloading it — a fetch the v1 grant catalog refuses.
- Sizing is `standard-3` × 4, which is what the ceiling leaves rather than what the pool wants: the
  four caps already sum to `CONTAINERS_CEILING` (16) while the dispatcher still holds 40 instances
  of the same account, so raising `task` today means taking them off another pool. The post-drain
  target is 12 at the same instance type — a task installs one repository and runs its suite, which
  never grows into the dispatcher's `standard-4`.
- The payload half is enforced at runtime rather than by an erased type. `SUBSTRATE_RECIPE_KEYS` in
  `packages/substrate-contract` is a value witness of the recipe's declared fields, derived from a
  `Record<keyof Required<SubstrateRecipe>, true>` so it cannot drift from the type; `poolPolicyView`
  in `apps/substrate/src/admission/pools.ts` projects every recipe through it before policy reads a
  field. An undeclared `pool` is therefore dropped by construction, not ignored by luck — and a
  refactor that reads one directly fails a Proxy-based test in `pools.test.ts`. A projection rather
  than a refusal, because this contract calls additive optional fields non-breaking: a newer
  consumer's recipe legitimately carries keys an older substrate build has never heard of.
- fractalbot's stage-3 bind does not wait on an unbuilt planning system.
- A future isolate tier enters as a policy-selected backend under the same invariant, or not at all —
  now with a concrete adoption bar. `@cloudflare/computer` (early preview, 2026-08-03) ships the
  hazard this ADR names: its `exec` tool takes a `backend` argument the model fills, steered by the
  tool description, with no platform-side admission. Adopting any part of it means the tier is
  pinned policy-side and that argument is never offered to a model. Its `CloudflareContainerBackend`
  is excluded outright on a second count — it makes the consumer's own Durable Object the container
  host, which is a container path around the ticket gate and the `containers`-stanza exclusivity
  ADR-0004 rests on.
- Adoption would widen the pinned security surface of ADR-0011 beyond the
  `@cloudflare/sandbox` + `@cloudflare/containers` pair, and the isolate tier's egress semantics must
  be measured against the released package rather than inferred — the preview's announcement states
  nothing about containment either way.
