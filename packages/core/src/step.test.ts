// Tests for `step` — the durable checkpoint boundary, exercised through the
// inline `StepRunner` and the in-memory `ExecutionsService` fake.
//
// Acceptance (specs/pm/plan.md § PR2):
//   * composing two steps records start+end once per step name;
//   * a step body failure is recorded as `failure` and stays in the typed `E`
//     channel — no throw escapes the Effect.

import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { ApprovalTimedOut, EventPayloadInvalid, ExecFailed } from "./errors";
import { enqueueInlineEvent, makeCFRuntimeTest } from "./testing";
import { step } from "./step";

it.effect("records one start+end step record per step name", () => {
  const { layer, handles } = makeCFRuntimeTest();

  return Effect.gen(function* () {
    const a = yield* step("a", () => Effect.succeed(1));
    const b = yield* step("b", () => Effect.succeed(a + 1));

    expect(b).toBe(2);

    // One step record per name — `finishStep` updates the row in place, so a
    // start+end pair is a single row with `status` populated.
    const { steps } = handles.executions;
    expect(steps.map((s) => s.name)).toEqual(["a", "b"]);
    expect(steps).toHaveLength(2);

    for (const s of steps) {
      expect(s.status).toBe("success");
      expect(typeof s.startedAt).toBe("number");
      expect(typeof s.completedAt).toBe("number");
      expect(s.completedAt!).toBeGreaterThanOrEqual(s.startedAt);
      expect(s.errorTag).toBeUndefined();
    }
  }).pipe(Effect.provide(layer));
});

it.effect("invokes the fake ExecutionsService exactly once per step", () => {
  const { layer, handles } = makeCFRuntimeTest();

  return Effect.gen(function* () {
    yield* step("only-step", () => Effect.succeed("ok"));

    expect(handles.executions.steps).toHaveLength(1);
    expect(handles.executions.steps[0]!.name).toBe("only-step");
  }).pipe(Effect.provide(layer));
});

it.effect("forwards step metadata to the ExecutionsService record", () => {
  const { layer, handles } = makeCFRuntimeTest();

  return Effect.gen(function* () {
    yield* step("with-meta", () => Effect.succeed(0), {
      metadata: { shard: 3 },
    });

    expect(handles.executions.steps[0]!.metadata).toEqual({ shard: 3 });
  }).pipe(Effect.provide(layer));
});

it.effect(
  "records a failed step and keeps the failure in the typed E channel",
  () => {
    const { layer, handles } = makeCFRuntimeTest();

    return Effect.gen(function* () {
      const failure = new ExecFailed({ exitCode: 1, stderrTail: "1 failing" });

      // The step body fails with a tagged error. `step` must NOT throw — the
      // failure flows through the `E` channel and is observable via `exit`.
      const exit = yield* Effect.exit(
        step("doomed", () => Effect.fail(failure)),
      );

      expect(exit._tag).toBe("Failure");

      // The step row is recorded as failed, tagged with the error's `_tag`.
      const { steps } = handles.executions;
      expect(steps).toHaveLength(1);
      expect(steps[0]!.name).toBe("doomed");
      expect(steps[0]!.status).toBe("failure");
      expect(steps[0]!.errorTag).toBe("ExecFailed");
      expect(steps[0]!.completedAt).toBeDefined();
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a failed step short-circuits subsequent steps", () => {
  const { layer, handles } = makeCFRuntimeTest();

  return Effect.gen(function* () {
    const program = Effect.gen(function* () {
      yield* step("first", () =>
        Effect.fail(new ExecFailed({ exitCode: 2, stderrTail: "boom" })),
      );
      // Should never run — the failed step aborts the gen.
      yield* step("second", () => Effect.succeed("unreachable"));
    });

    yield* Effect.exit(program);

    const names = handles.executions.steps.map((s) => s.name);
    expect(names).toEqual(["first"]);
  }).pipe(Effect.provide(layer));
});

it.effect("step recovers via Effect.catchTag inside the run", () => {
  const { layer, handles } = makeCFRuntimeTest();

  return Effect.gen(function* () {
    const recovered = yield* step("flaky", () =>
      Effect.fail(new ExecFailed({ exitCode: 1, stderrTail: "x" })),
    ).pipe(Effect.catchTag("ExecFailed", () => Effect.succeed("recovered")));

    expect(recovered).toBe("recovered");
    // The step is still recorded as failed — recovery happens *after* the
    // step boundary.
    expect(handles.executions.steps[0]!.status).toBe("failure");
  }).pipe(Effect.provide(layer));
});

const Approval = Schema.Struct({
  decision: Schema.Literal("approve", "reject"),
  deciderEmail: Schema.String,
});

it.effect("step.waitForEvent resolves with a queued event payload", () => {
  const { layer, handles } = makeCFRuntimeTest();
  // Pre-queue an approval event the run will pick up.
  enqueueInlineEvent(handles.eventQueue, "release-approval", {
    decision: "approve",
    deciderEmail: "alice@example.com",
  });

  return Effect.gen(function* () {
    const approval = yield* step.waitForEvent("release-approval", {
      type: "release-approval",
      timeout: "72 hours",
      payloadSchema: Approval,
    });
    expect(approval).toEqual({
      decision: "approve",
      deciderEmail: "alice@example.com",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("step.waitForEvent fails with ApprovalTimedOut on empty queue", () => {
  const { layer } = makeCFRuntimeTest();

  return Effect.gen(function* () {
    const exit = yield* Effect.exit(
      step.waitForEvent("release-approval", {
        type: "release-approval",
        timeout: "1 hour",
        payloadSchema: Approval,
      }),
    );
    expect(exit._tag).toBe("Failure");
    // Recover so the test asserts the tag.
    const recovered = yield* step
      .waitForEvent("release-approval", {
        type: "release-approval",
        timeout: "1 hour",
        payloadSchema: Approval,
      })
      .pipe(
        Effect.catchTag("ApprovalTimedOut", (e: ApprovalTimedOut) =>
          Effect.succeed(`timed-out:${e.eventName}`),
        ),
      );
    expect(recovered).toBe("timed-out:release-approval");
  }).pipe(Effect.provide(layer));
});

it.effect(
  "step.waitForEvent fails with EventPayloadInvalid on schema mismatch",
  () => {
    const { layer, handles } = makeCFRuntimeTest();
    // Queue a malformed payload — missing `deciderEmail`.
    enqueueInlineEvent(handles.eventQueue, "release-approval", {
      decision: "approve",
    });

    return Effect.gen(function* () {
      const recovered = yield* step
        .waitForEvent("release-approval", {
          type: "release-approval",
          timeout: "1 hour",
          payloadSchema: Approval,
        })
        .pipe(
          Effect.catchTag("EventPayloadInvalid", (e: EventPayloadInvalid) =>
            Effect.succeed(`bad:${e.eventName}`),
          ),
        );
      expect(recovered).toBe("bad:release-approval");
    }).pipe(Effect.provide(layer));
  },
);
