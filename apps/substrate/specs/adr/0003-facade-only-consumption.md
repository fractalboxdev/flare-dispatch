# ADR-0003: Consumers reach the substrate only through a service-binding facade

- **Status:** Proposed
- **Date:** 2026-08-06

## Context

A cross-script Durable Object namespace binding would hand consumers the full Sandbox class surface —
including the SDK's inherited, unfenced `exec` — and bypass admission entirely. fractalbot's history
shows the fence decaying as a call-path convention: its own workflow once called `runTaskCommand`
directly around the `exec.ts` fence ("the predicted defect arriving on schedule", fractalbot
ADR-0005). The carve is the one chance to make the fence structural. Two other couplings must not
survive the boundary: fractalbot's container DO reads recipes and backup handles back out of the
conversation DO (a substrate→consumer dependency), and grants bind to a DO id read off the stub,
which a remote consumer cannot see.

## Decision

The substrate is consumed exclusively through a `WorkerEntrypoint` facade over a service binding:

- `ensureSandbox(key, recipe, admission)` → `EnsureResult`
- `execUnderGrant(key, {recipe, command, idempotencyKey, logPath, timeoutMs, tailBytes, lfs,
  approval?})` → `GuardedExecOutcome` — the stale-revoke → ensure → apply → run → kill-before-revoke
  sequence runs entirely inside the substrate, which derives the grant from the recipe and its own DO id
- `checkpoint(key, reason)` · `abort(key)` (kill + stop — the consumer's off-switch)
- `admission.enqueue/attempt/release`, `poolStatus()` (ADR-0004)

`HandleStore` is owned and stored by the substrate, keyed by sandbox key + recipeVersion passed in on
ensure/checkpoint — the substrate never calls back into a consumer. `GrantTarget`, `buildGrant`, and the
egress handlers are internal; the SDK's unfenced `exec` and raw DO stubs are never exported. The
boundary speaks plain structural types; Effect layers wrap consumer-side.

## Consequences

- The fence cannot be bypassed by construction; admission cannot be skipped by binding-holders.
- Retried `execUnderGrant` with the same idempotencyKey must join the in-flight command, not re-run —
  the DO-side receipt + in-flight dedupe is the correctness backbone of the cross-worker contract
  and ships with a test.
- Dependencies are one-way forever: the substrate compiles with zero knowledge of any consumer.
