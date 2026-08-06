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

## Consequences

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
