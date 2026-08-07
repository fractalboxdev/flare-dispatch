// @fractalboxdev/flare-dispatch-core — CurrentStep: which durable checkpoint a
// capability call is running inside.
//
// A capability that has to identify one unit of work needs a name that is
// stable across retries of that unit and distinct from every other unit — and
// the only value in the system with both properties is the step name. A
// counter kept inside a Layer has neither: a memoized step never re-enters the
// Layer, so a replayed execution numbers its live calls differently from the
// attempt that recorded them.
//
// `step(name, …)` provides this Tag around the body, so anything the body
// reaches — including a capability whose interface declares `R = never` — can
// read it with `Effect.serviceOption(CurrentStep)`. Optional by construction:
// a capability call outside any step (`loadSecrets`, an inline `io.now`) sees
// `Option.none()` and falls back to whatever it did before.
//
// The one consumer today is the substrate facade's exec idempotency key
// (packages/runtime-cf/src/sandbox-facade.ts). It is NOT part of `RunContext`:
// a run body must not depend on knowing its own step name, and a Tag outside
// the aggregate cannot be required by one.

import { Context } from "effect";

export type CurrentStepInfo = {
  /** The `step(name, …)` name of the enclosing checkpoint. */
  readonly name: string;
};

export class CurrentStep extends Context.Tag("@fractalboxdev/flare-dispatch-core/CurrentStep")<
  CurrentStep,
  CurrentStepInfo
>() {}
