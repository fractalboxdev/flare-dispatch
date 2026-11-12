// The run-level wall-clock ceiling — `limits.maxDurationSec` (issue #42).
//
// A Cloudflare Workflow replays its run body on every resume, so a ceiling
// measured from process uptime would restart on each replay and never fire.
// The caller supplies `startedAt` from a checkpointed step; each invocation
// spends only what remains of the ceiling, and a replay that wakes past it
// fails before re-entering the body.

import { Clock, Duration, Effect } from "effect";
import { RunDurationExceeded } from "./errors";

export type RunCeiling = {
  /** The run's declared `limits.maxDurationSec`. */
  readonly maxDurationSec: number;
  /** Epoch ms at which the body first started — persisted, replay-stable. */
  readonly startedAt: number;
};

/** Bound `body` by what remains of the ceiling at `startedAt + maxDurationSec`. */
export const withRunCeiling = <A, E, R>(
  body: Effect.Effect<A, E, R>,
  { maxDurationSec, startedAt }: RunCeiling,
): Effect.Effect<A, E | RunDurationExceeded, R> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const elapsedMs = Math.max(0, now - startedAt);
    const remainingMs = maxDurationSec * 1000 - elapsedMs;
    if (remainingMs <= 0) {
      return yield* new RunDurationExceeded({
        maxDurationSec,
        elapsedSec: Math.round(elapsedMs / 1000),
      });
    }
    return yield* body.pipe(
      Effect.timeoutFail({
        duration: Duration.millis(remainingMs),
        onTimeout: () => new RunDurationExceeded({ maxDurationSec, elapsedSec: maxDurationSec }),
      }),
    );
  });
