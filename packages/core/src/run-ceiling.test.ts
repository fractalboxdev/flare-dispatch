// Tests for `withRunCeiling` — the run-level wall-clock ceiling
// (`limits.maxDurationSec`, issue #42). The clock starts at a persisted start
// time, so a Workflow replay resumes the countdown instead of restarting it.

import { it } from "@effect/vitest";
import { Effect, Either, Fiber, TestClock } from "effect";
import { expect } from "vitest";
import { RunDurationExceeded } from "./errors";
import { withRunCeiling } from "./run-ceiling";

const MINUTE = 60_000;

it.effect("a body that finishes inside the ceiling succeeds untouched", () =>
  Effect.gen(function* () {
    const body = Effect.sleep("10 minutes").pipe(Effect.as("done"));
    const fiber = yield* Effect.fork(withRunCeiling(body, { maxDurationSec: 1800, startedAt: 0 }));
    yield* TestClock.adjust("10 minutes");
    expect(yield* Fiber.join(fiber)).toBe("done");
  }),
);

it.effect("a body that outlives the ceiling fails RunDurationExceeded at the ceiling", () =>
  Effect.gen(function* () {
    let finished = false;
    const body = Effect.sleep("3 hours").pipe(Effect.tap(() => (finished = true)));
    const fiber = yield* Effect.fork(
      Effect.either(withRunCeiling(body, { maxDurationSec: 1800, startedAt: 0 })),
    );
    yield* TestClock.adjust("30 minutes");
    const result = yield* Fiber.join(fiber);
    expect(Either.isLeft(result)).toBe(true);
    const err = Either.getLeft(result).pipe((o) => (o._tag === "Some" ? o.value : undefined));
    expect(err).toBeInstanceOf(RunDurationExceeded);
    expect(err?.maxDurationSec).toBe(1800);
    expect(err?.elapsedSec).toBe(1800);
    expect(finished).toBe(false);
  }),
);

it.effect("a replay measures from the persisted start, not from the replay", () =>
  Effect.gen(function* () {
    // The run began 25 min before this invocation; 5 min of ceiling remain.
    yield* TestClock.setTime(25 * MINUTE);
    const body = Effect.sleep("20 minutes");
    const fiber = yield* Effect.fork(
      Effect.either(withRunCeiling(body, { maxDurationSec: 1800, startedAt: 0 })),
    );
    yield* TestClock.adjust("5 minutes");
    const result = yield* Fiber.join(fiber);
    expect(Either.getLeft(result).pipe((o) => (o._tag === "Some" ? o.value._tag : undefined))).toBe(
      "RunDurationExceeded",
    );
  }),
);

it.effect("a replay past the ceiling fails at once without entering the body", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(3 * 60 * MINUTE);
    let entered = false;
    const body = Effect.sync(() => {
      entered = true;
    });
    const result = yield* Effect.either(
      withRunCeiling(body, { maxDurationSec: 1800, startedAt: 0 }),
    );
    expect(entered).toBe(false);
    const err = Either.getLeft(result).pipe((o) => (o._tag === "Some" ? o.value : undefined));
    expect(err?._tag).toBe("RunDurationExceeded");
    expect(err?.elapsedSec).toBe(3 * 3600);
  }),
);

it.effect("a parent with a 30-hour ceiling keeps running past every child-sized ceiling", () =>
  Effect.gen(function* () {
    const body = Effect.sleep("20 hours").pipe(Effect.as("settled"));
    const fiber = yield* Effect.fork(
      withRunCeiling(body, { maxDurationSec: 30 * 3600, startedAt: 0 }),
    );
    yield* TestClock.adjust("20 hours");
    expect(yield* Fiber.join(fiber)).toBe("settled");
  }),
);

it("RunDurationExceeded.message states the ceiling for the Workflows attempt record", () => {
  const err = new RunDurationExceeded({ maxDurationSec: 1800, elapsedSec: 1800 });
  expect(err.message).toBe("run exceeded its 30 min ceiling (limits.maxDurationSec = 1800)");
});
