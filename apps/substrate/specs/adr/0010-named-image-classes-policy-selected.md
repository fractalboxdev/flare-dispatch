# ADR-0010: Named image classes, selected by policy — never by the model or the payload

- **Status:** Proposed
- **Date:** 2026-08-06

## Context

Cloudflare requires a distinct Durable Object class per container image; every image must exist at
deploy time as a class in the `containers` config — there is no runtime image composition.
flare-dispatch's planned `RequiredCapabilities` image planning is design-doc only (zero code hits),
so any "declare what you need" scheme can only ever select among baked classes. Separately,
fractalbot's ADR-0013 established the invariant the substrate must inherit before its isolate tier ever
lands: an execution backend the model can name is an egress posture the model can choose — every
containment control is a property of the Sandbox class, and an isolate/dynamic-worker tier escapes
all of them.

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
- A future isolate tier (Cloudflare Computer) enters as a policy-selected backend under the same
  invariant, or not at all.
