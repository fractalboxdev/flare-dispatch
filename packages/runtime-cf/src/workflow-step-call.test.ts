import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import { describe, expect } from "vitest";
import {
  EngineInterrupted,
  EventPayloadInvalid,
  isEngineInterruptedCause,
  StepFailed,
  StepRunner,
} from "@fractalboxdev/flare-dispatch-core";
import { makeExecutionsFake, makeIOFake } from "@fractalboxdev/flare-dispatch-core/testing";
import { makeStepRunnerCloudflare } from "./step-runner-cf";
import { callWorkflowStep, guardWorkflowStep } from "./workflow-step-call";

const inactive =
  "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.";
const reset = "Durable Object reset because its code was updated.";

const engineRejects = (message: string) => ({
  do: (): Promise<never> => Promise.reject(new Error(message)),
  sleep: (): Promise<never> => Promise.reject(new Error(message)),
  waitForEvent: (): Promise<never> => Promise.reject(new Error(message)),
});

const runnerOver = (step: ReturnType<typeof engineRejects>) => {
  const executions = makeExecutionsFake();
  const layer = makeStepRunnerCloudflare(step, "exec-1").pipe(
    Layer.provide(Layer.merge(executions.layer, makeIOFake().layer)),
  );
  return { layer, executions: executions.state };
};

describe("callWorkflowStep", () => {
  it.effect("an engine rejection dies EngineInterrupted, past catchTag, either and retry", () =>
    Effect.gen(function* () {
      const call = callWorkflowStep("open", () => Promise.reject(new Error(inactive)), (cause) =>
        new StepFailed({ step: "open", cause }),
      );
      const exit = yield* Effect.exit(
        call.pipe(
          Effect.retry({ times: 2 }),
          Effect.catchTag("StepFailed", () => Effect.succeed("recovered")),
          Effect.either,
        ),
      );
      expect(Exit.isFailure(exit) && isEngineInterruptedCause(exit.cause)).toBe(true);
    }),
  );

  it.effect("any other rejection is the caller's typed failure", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        callWorkflowStep("open", () => Promise.reject(new Error("boom")), (cause) =>
          new StepFailed({ step: "open", cause }),
        ),
      );
      expect(Exit.isFailure(exit) && isEngineInterruptedCause(exit.cause)).toBe(false);
      if (Exit.isFailure(exit))
        expect(Option.getOrUndefined(Cause.failureOption(exit.cause))).toBeInstanceOf(StepFailed);
    }),
  );
});

describe("guardWorkflowStep", () => {
  it("latches on the first engine rejection and refuses every later call", async () => {
    let calls = 0;
    const { step, lost } = guardWorkflowStep({
      do: (_name: string, cb: () => Promise<unknown>) =>
        ++calls === 1 ? Promise.reject(new Error(reset)) : cb(),
    });
    await expect(step.do("a", async () => 1)).rejects.toThrow(reset);
    expect(lost()).toBe(true);
    await expect(step.do("b", async () => 2)).rejects.toThrow(reset);
    expect(calls).toBe(1);
  });

  it("leaves a step that failed for any other reason open", async () => {
    let calls = 0;
    const { step, lost } = guardWorkflowStep({
      do: (_name: string, cb: () => Promise<unknown>) =>
        ++calls === 1 ? Promise.reject(new Error("boom")) : cb(),
    });
    await expect(step.do("a", async () => 1)).rejects.toThrow("boom");
    await expect(step.do("b", async () => 2)).resolves.toBe(2);
    expect(lost()).toBe(false);
  });
});

describe("a step body that quotes the engine", () => {
  /** A live engine: `do` runs the callback and rejects with its error, as Workflows does. */
  const liveEngine = {
    do: <T>(_name: string, cb: () => Promise<T>): Promise<T> => cb(),
  };

  it("is the body's failure: the guard stays open and the call fails typed", async () => {
    const { step, lost } = guardWorkflowStep(liveEngine);
    const exit = await Effect.runPromiseExit(
      callWorkflowStep(
        "exec-start",
        () => step.do("exec-start", () => Promise.reject(new Error(`ExecFailed: ${reset}`))),
        (cause) => new StepFailed({ step: "exec-start", cause }),
      ),
    );
    expect(Exit.isFailure(exit) && isEngineInterruptedCause(exit.cause)).toBe(false);
    expect(lost()).toBe(false);
    await expect(step.do("next", async () => 1)).resolves.toBe(1);
  });

  it.effect("reaches the run as its typed failure through StepRunnerCloudflare", () => {
    const executions = makeExecutionsFake();
    const layer = makeStepRunnerCloudflare(liveEngine, "exec-1").pipe(
      Layer.provide(Layer.merge(executions.layer, makeIOFake().layer)),
    );
    return Effect.gen(function* () {
      const runner = yield* StepRunner;
      const exit = yield* Effect.exit(
        runner.run("exec-start", () =>
          Effect.fail(new StepFailed({ step: "sandbox", cause: inactive })),
        ) as Effect.Effect<never, StepFailed>,
      );
      expect(Exit.isFailure(exit) && isEngineInterruptedCause(exit.cause)).toBe(false);
      expect(executions.state.steps[0]?.status).toBe("failure");
    }).pipe(Effect.provide(layer));
  });
});

describe("StepRunnerCloudflare on an engine rejection", () => {
  it.effect("run dies EngineInterrupted and records no failed step", () => {
    const { layer, executions } = runnerOver(engineRejects(inactive));
    return Effect.gen(function* () {
      const runner = yield* StepRunner;
      // The rejection lands before the body runs, so no capability is read.
      const exit = yield* Effect.exit(
        runner.run("exec-start", () => Effect.succeed(1)) as Effect.Effect<number, StepFailed>,
      );
      expect(Exit.isFailure(exit) && isEngineInterruptedCause(exit.cause)).toBe(true);
      expect(executions.steps.filter((s) => s.status === "failure")).toHaveLength(0);
      expect(executions.steps[0]?.completedAt).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("sleep dies EngineInterrupted, not StepFailed", () => {
    const { layer } = runnerOver(engineRejects(inactive));
    return Effect.gen(function* () {
      const runner = yield* StepRunner;
      const exit = yield* Effect.exit(runner.sleep!("exec-sleep-0", 5000));
      expect(Exit.isFailure(exit) && isEngineInterruptedCause(exit.cause)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("waitForEvent dies EngineInterrupted, not EventPayloadInvalid", () => {
    const { layer } = runnerOver(engineRejects(reset));
    return Effect.gen(function* () {
      const runner = yield* StepRunner;
      const exit = yield* Effect.exit(
        runner.waitForEvent("approval", {
          type: "approve",
          timeout: "1 hour",
          payloadSchema: Schema.Unknown,
        }) as Effect.Effect<unknown, unknown>,
      );
      expect(Exit.isFailure(exit) && isEngineInterruptedCause(exit.cause)).toBe(true);
      if (Exit.isFailure(exit))
        expect(Option.isNone(Cause.failureOption(exit.cause))).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});

describe("EngineInterrupted", () => {
  it("is found anywhere in a composite cause, and a typed failure quoting the message is not", () => {
    const interrupted = Cause.die(new EngineInterrupted({ step: "s", reason: inactive }));
    expect(isEngineInterruptedCause(Cause.parallel(Cause.fail("other"), interrupted))).toBe(true);
    expect(isEngineInterruptedCause(Cause.fail(new EventPayloadInvalid({ eventName: "e", reason: inactive })))).toBe(false);
    expect(isEngineInterruptedCause(Cause.die(new Error(inactive)))).toBe(false);
  });
});
