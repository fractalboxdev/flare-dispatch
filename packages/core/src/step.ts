// @fractalboxdev/flare-dispatch-core — step: the durable checkpoint boundary.
//
// `step(name, body)` wraps an Effect in a durable, individually-recorded
// checkpoint. It does NOT itself decide *how* the checkpoint is realised —
// that is the `StepRunner` service's job (services/step-runner.ts), which is a
// swappable Layer:
//
//   * the test/dev runtime binds `StepRunnerInline` — runs the body inline and
//     records start/end into `ExecutionsService`;
//   * PR4's CF runtime binds `StepRunnerCloudflare` — backs each call with
//     `WorkflowStep.do(name, ...)` so the step is durable and retryable.
//
// `step` itself is just the DSL surface: read `StepRunner` from context, hand
// it the body. Keeping the *mechanism* behind a Tag is the seam PR4 needs.
//
// The `runEffect` shim reconciles Workflows (imperative — throws to fail a
// step) with Effect (typed E channel — never throws): inside a step body the
// Effect rules apply; at the Workflow boundary the shim throws a typed failure
// so Workflows records it in its retry telemetry. PR4's `StepRunnerCloudflare`
// is the only caller of `runEffect` — it runs the body inside `step.do`'s
// Promise callback. The test runner never needs it (no Promise boundary).
//
// Spec: specs/03-dsl.md § step + § The runEffect boundary shim.

import { Cause, type Duration, Effect, Exit, Option, type Schema } from "effect";
import type { RunContext } from "./context";
import type { ApprovalTimedOut, EventPayloadInvalid, StepFailed } from "./errors";
import { StepRunner } from "./services/step-runner";
import type { StepOpts } from "./step-opts";

export type { StepOpts };

/**
 * Render a typed failure into a string, for the OWN `message` of the plain
 * Error thrown at the Workflow boundary below.
 *
 * Both halves of a tagged error are prototype-level: `name` comes from the tag
 * and `message` from either a subclass `get message()` (ExecFailed, ExecTimeout)
 * or Effect's default props rendering. Neither is an own data property, and the
 * boundary serializes own data properties — so a tagged error thrown as-is
 * reaches the Workflows attempt record as `{"name":"Error","message":""}` or
 * worse, naming nothing. `ExecFailed` cost a real investigation this way: the
 * attempt record said `ExecFailed` and no more, and the actual reason (the
 * workspace was gone) survived only in the R2 exec log, which exists only
 * because `sandbox.exec` happens to write one before it raises.
 *
 * Reading both halves HERE, while the error is still live, and folding them
 * into one own-property message is what makes the reason durable — and it does
 * it once for every tagged error rather than per class. `name` still degrades
 * to `Error` in the record (the clone algorithm keeps only the built-in error
 * names), which is exactly why the tag is prefixed onto the message.
 */
const describeFailure = (failure: unknown): string => {
  if (!(failure instanceof Error)) return String(failure);
  // `_tag` read as DATA, not branched on — the same read `errorTagOf` in
  // step-runner-cf.ts makes, and for the same reason: the label has to be
  // derived from an error whose type is not known here. It is preferred over
  // `Error.name` because a payload field named `name` shadows it on the
  // instance (`ArtifactUploadFailed`), which would otherwise label the record
  // with the artifact's name instead of the failure's.
  const tag = (failure as { _tag?: unknown })._tag;
  const label = typeof tag === "string" ? tag : failure.name;
  const detail = failure.message;
  return detail.length > 0 && detail !== label ? `${label}: ${detail}` : label;
};

/**
 * Execute an Effect at the Workflow step boundary, rethrowing typed failures.
 *
 * The Effect must already have its `RunContext` provided by the runtime Layer
 * (`R = never`) before it reaches the boundary — `runEffect` is the imperative
 * shim, not the place capabilities are supplied. PR4's `StepRunnerCloudflare`
 * calls this inside the `WorkflowStep.do(...)` Promise callback.
 *
 * The thrown value is always a plain `Error` carrying the Effect `Cause`. The
 * typed `E` channel rides on that `cause` — `StepRunnerCloudflare` re-fails with
 * it via `Effect.failCause`, and reads the `_tag` off it for the `steps` row —
 * so nothing downstream depends on the identity of the throw. It is the
 * Workflows telemetry carrier and nothing else, which is what frees it to be
 * shaped for a record that survives serialization (see `describeFailure`).
 */
export const runEffect = <A, E>(eff: Effect.Effect<A, E, never>) =>
  Effect.runPromiseExit(eff).then((exit) =>
    Exit.match(exit, {
      onSuccess: (a) => a,
      onFailure: (cause) => {
        // Some => a typed run failure; None => a defect, rendered from the
        // pretty Cause. Branch the Option — never read `._tag` raw.
        const err = Option.match(Cause.failureOption(cause), {
          onSome: (failure) => new Error(describeFailure(failure)),
          onNone: () => new Error(Cause.pretty(cause)),
        });
        (err as { cause?: unknown }).cause = cause;
        throw err;
      },
    }),
  );

type StepFn = {
  /**
   * Wrap an Effect in a durable checkpoint. Step names must be unique within a
   * run — they are the dedup key for checkpoint replay. Delegates to the
   * ambient `StepRunner`: a body failure stays in the typed `E` channel
   * (re-failed, never thrown out of the Effect); `StepFailed` is added to the
   * channel for infra failures the runner surfaces.
   */
  <A, E>(
    name: string,
    body: () => Effect.Effect<A, E, RunContext>,
    opts?: StepOpts,
  ): Effect.Effect<A, E | StepFailed, RunContext>;

  /**
   * Hibernate the Workflow until an external event arrives, or time out.
   * Delegates to the ambient `StepRunner.waitForEvent` — the inline runner
   * reads from a test-supplied event queue; `StepRunnerCloudflare` wraps the
   * CF `WorkflowStep.waitForEvent` API.
   */
  readonly waitForEvent: <P, I = unknown>(
    name: string,
    opts: {
      type: string;
      timeout: Duration.Duration | string;
      payloadSchema: Schema.Schema<P, I>;
    },
  ) => Effect.Effect<P, ApprovalTimedOut | EventPayloadInvalid, RunContext>;
};

const stepImpl = <A, E>(
  name: string,
  body: () => Effect.Effect<A, E, RunContext>,
  opts?: StepOpts,
): Effect.Effect<A, E | StepFailed, RunContext> =>
  Effect.flatMap(StepRunner, (runner) => runner.run(name, body, opts));

const waitForEvent = <P, I>(
  name: string,
  opts: {
    type: string;
    timeout: Duration.Duration | string;
    payloadSchema: Schema.Schema<P, I>;
  },
): Effect.Effect<P, ApprovalTimedOut | EventPayloadInvalid, RunContext> =>
  Effect.flatMap(StepRunner, (runner) => runner.waitForEvent(name, opts));

export const step: StepFn = Object.assign(stepImpl, { waitForEvent });
