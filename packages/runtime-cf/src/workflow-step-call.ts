// @fractalboxdev/flare-dispatch-runtime-cf — the one door into a Workflows step API.
//
// Every `step.do` / `step.sleep` / `step.waitForEvent` call goes through
// `callWorkflowStep`, which reads the rejection while it is still the raw
// error the engine raised. That is the only place it can be read reliably:
// past this point an Effect wrapper (`tryPromise`'s `UnknownException`, a
// `StepFailed`, a `FiberFailure`) owns its message, and a classifier
// downstream ends up unwrapping chains of guesses.
//
// An engine rejection becomes the `EngineInterrupted` defect (see core's
// engine-interruption.ts for why a defect and not a failure); every other
// rejection is the caller's to map.

import { EngineInterrupted } from "@fractalboxdev/flare-dispatch-core";
import { Effect } from "effect";

/** Messages the runtime raises when an instance's Durable Object goes away. */
const ENGINE_GONE = [
  /Durable Object instance is no longer active/i,
  /Durable Object reset because its code was updated/i,
];

/**
 * Rejections the step's own callback produced. When a callback fails, `step.do`
 * rejects with the callback's error, and a body whose own Durable Object call
 * failed (a Sandbox reset by a deploy) quotes the engine's words while the
 * engine is alive. Classifying that as an interruption would leave the run
 * `running` forever: nothing replays an instance whose engine never left.
 */
const bodyRejections = new WeakSet<object>();

export const isEngineGone = (error: unknown): error is Error =>
  error instanceof Error &&
  !bodyRejections.has(error) &&
  ENGINE_GONE.some((pattern) => pattern.test(error.message));

/**
 * Call a Workflows step API. A rejection the engine raised as it lost the
 * instance dies `EngineInterrupted`; any other rejection fails with
 * `onReject(error)`.
 */
export const callWorkflowStep = <A, E>(
  step: string,
  call: () => Promise<A>,
  onReject: (error: unknown) => E,
): Effect.Effect<A, E> =>
  Effect.tryPromise({ try: call, catch: (error) => error }).pipe(
    Effect.catchAll((error) =>
      isEngineGone(error)
        ? Effect.die(new EngineInterrupted({ step, reason: error.message }))
        : Effect.fail(onReject(error)),
    ),
  );

type StepCall = (...args: never[]) => Promise<unknown>;
type StepSurface = {
  readonly do: StepCall;
  readonly sleep?: StepCall;
  readonly sleepUntil?: StepCall;
  readonly waitForEvent?: StepCall;
};

/**
 * The invocation's `WorkflowStep`, latched on the first engine rejection.
 *
 * An engine interruption ends the invocation, not just the step that saw it.
 * A run may recover any cause of a best-effort step (`catchAllCause` around an
 * upload or a PR comment), which would recover the interruption with it and
 * carry on deciding. So the loss is recorded where it is first seen: every
 * later call on the guarded step rejects with the same engine error, and
 * `lost()` lets the dispatcher withhold the verdict even when the run body
 * swallowed the defect and returned.
 */
export const guardWorkflowStep = <S extends StepSurface>(
  step: S,
): { readonly step: S; readonly lost: () => boolean } => {
  let gone: Error | undefined;
  const guard = <F extends StepCall>(call: F | undefined): F | undefined =>
    call === undefined
      ? undefined
      : ((async (...args: Parameters<F>) => {
          if (gone !== undefined) throw gone;
          // The body's own failure reaches `step.do`'s rejection with its
          // message intact; an engine loss during a retry backoff does not
          // carry it. Matching the message, not "an attempt threw", keeps a
          // loss after a failed attempt an interruption.
          let bodyMessage: string | undefined;
          const last = args.length - 1;
          const callback = args[last] as unknown;
          if (typeof callback === "function") {
            (args as unknown[])[last] = async (...attempt: unknown[]) => {
              try {
                return await (callback as (...a: unknown[]) => Promise<unknown>)(...attempt);
              } catch (error) {
                bodyMessage = error instanceof Error ? error.message : String(error);
                throw error;
              }
            };
          }
          try {
            return await call.apply(step, args);
          } catch (error) {
            if (bodyMessage !== undefined && error instanceof Error && error.message === bodyMessage)
              bodyRejections.add(error);
            if (isEngineGone(error)) gone = error;
            throw error;
          }
        }) as F);
  // A plain object over the methods the runtime calls: the platform's step
  // may be a stub whose other members do not survive re-binding.
  const guarded = {
    do: guard(step.do),
    ...(step.sleep !== undefined ? { sleep: guard(step.sleep) } : {}),
    ...(step.sleepUntil !== undefined ? { sleepUntil: guard(step.sleepUntil) } : {}),
    ...(step.waitForEvent !== undefined ? { waitForEvent: guard(step.waitForEvent) } : {}),
  } as unknown as S;
  return { step: guarded, lost: () => gone !== undefined };
};
