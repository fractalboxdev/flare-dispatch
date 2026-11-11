import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { retryable, withDispatchRetry } from "./dispatching.ts";
import { EXIT, FdFailure } from "./outcome.ts";

const failing = (status: number | undefined) =>
  new FdFailure({
    code: status === undefined ? "transport" : "unavailable",
    message: "x",
    exitCode: EXIT.noVerdict,
    ...(status === undefined ? {} : { status }),
  });

describe("fd dispatch retry", () => {
  it("[FD-IFC-066]: a 5xx or a network failure is retried, and every 4xx is final", () => {
    expect(retryable(failing(503))).toBe(true);
    expect(retryable(failing(undefined))).toBe(true);
    for (const status of [400, 401, 403, 404, 409, 422, 429])
      expect(retryable(failing(status))).toBe(false);
  });

  it("[FD-IFC-066]: up to 3 attempts in total, sleeping attempt × 5 s between them", async () => {
    let attempts = 0;
    const attempt = Effect.suspend(() => {
      attempts++;
      return Effect.fail(failing(undefined));
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.flip(withDispatchRetry(attempt)));
        yield* TestClock.adjust("4999 millis");
        const afterFirst = attempts;
        yield* TestClock.adjust("1 millis");
        yield* TestClock.adjust("10 seconds");
        const failure = yield* Fiber.join(fiber);
        return { afterFirst, failure };
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(result.afterFirst).toBe(1);
    expect(attempts).toBe(3);
    expect(result.failure.code).toBe("transport");
  });
});
