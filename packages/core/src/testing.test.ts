// Tests for the in-memory test runtime — the fakes and `CFRuntimeTest`.
// Exercises each capability through its accessor namespace against the fake
// Layer, and verifies the inspectable handles record the calls.

import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { artifact } from "./services/artifact";
import { checks } from "./services/checks";
import { io } from "./services/io";
import { sandbox } from "./services/sandbox";
import { step } from "./step";
import { makeCFRuntimeTest, sandboxFakeProgram } from "./testing";

it.effect("sandbox fake returns canned exec results from a program", () => {
  const { layer, handles } = makeCFRuntimeTest({
    sandboxProgram: {
      "pnpm test": { exitCode: 1, stderr: "1 failing" },
    },
  });

  return Effect.gen(function* () {
    const result = yield* sandbox.exec({ command: "pnpm test" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("1 failing");
    expect(handles.sandbox.execs).toHaveLength(1);
    expect(handles.sandbox.execs[0]!.command).toBe("pnpm test");
  }).pipe(Effect.provide(layer));
});

it.effect("sandbox fake exits 0 for an unmatched command", () => {
  const { layer } = makeCFRuntimeTest();

  return Effect.gen(function* () {
    const result = yield* sandbox.exec({ command: "echo hello" });
    expect(result.exitCode).toBe(0);
  }).pipe(Effect.provide(layer));
});

it.effect("sandbox fake program can raise ExecTimeout", () => {
  const { layer } = makeCFRuntimeTest({
    sandboxProgram: { "sleep 999": { fail: "ExecTimeout", timeoutSec: 30 } },
  });

  return Effect.gen(function* () {
    const exit = yield* Effect.exit(sandbox.exec({ command: "sleep 999" }));
    expect(exit._tag).toBe("Failure");
  }).pipe(Effect.provide(layer));
});

it.effect("artifact fake returns a deterministic signed URL", () => {
  const { layer, handles } = makeCFRuntimeTest();

  return Effect.gen(function* () {
    const url = yield* artifact.upload({
      name: "step.log",
      path: "/tmp/step.log",
    });

    expect(url).toBe("https://fake-r2.local/step.log");
    expect(handles.artifact.uploads).toHaveLength(1);
    expect(handles.artifact.urls.get("step.log")).toBe(url);
  }).pipe(Effect.provide(layer));
});

it.effect("io fake is deterministic — clock advances, uuids count up", () => {
  const { layer } = makeCFRuntimeTest({ io: { startMs: 1000, tickMs: 5 } });

  return Effect.gen(function* () {
    const t0 = yield* io.now;
    const t1 = yield* io.now;
    const u0 = yield* io.uuid;
    const u1 = yield* io.uuid;

    expect(t0).toBe(1000);
    expect(t1).toBe(1005);
    expect(u0).toBe("00000000-0000-4000-8000-000000000001");
    expect(u1).toBe("00000000-0000-4000-8000-000000000002");
  }).pipe(Effect.provide(layer));
});

it.effect("checks fake records create then update calls", () => {
  const { layer, handles } = makeCFRuntimeTest();

  return Effect.gen(function* () {
    const checkRunId = yield* checks.create({
      repo: "o/n",
      sha: "abc",
      name: "offload-test",
    });
    yield* checks.update({ repo: "o/n", checkRunId, conclusion: "success" });

    expect(handles.checks.creates).toHaveLength(1);
    expect(handles.checks.creates[0]!.name).toBe("offload-test");
    expect(handles.checks.updates).toHaveLength(1);
    expect(handles.checks.updates[0]!.conclusion).toBe("success");
    expect(handles.checks.updates[0]!.checkRunId).toBe(checkRunId);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "a multi-step run threads sandbox + artifact through the test runtime",
  () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "pnpm test": { exitCode: 0 } },
    });

    return Effect.gen(function* () {
      const result = yield* step("exec", () =>
        sandbox.exec({ command: "pnpm test" }),
      );
      const url = yield* step("upload-log", () =>
        artifact.upload({ name: "step.log", path: result.logPath }),
      );

      expect(result.exitCode).toBe(0);
      expect(url).toBe("https://fake-r2.local/step.log");

      // Two steps, each recorded once.
      expect(handles.executions.steps.map((s) => s.name)).toEqual([
        "exec",
        "upload-log",
      ]);
      expect(
        handles.executions.steps.every((s) => s.status === "success"),
      ).toBe(true);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("sandboxFakeProgram is the standalone Layer helper", () => {
  // The shape from specs/03-dsl.md § Unit-testing runs: a sandbox-only Layer.
  const sandboxLayer = sandboxFakeProgram({ "git clone": { exitCode: 0 } });
  const { layer } = makeCFRuntimeTest();

  return Effect.gen(function* () {
    const dir = yield* sandbox.git.clone({ repo: "o/n", sha: "abc" });
    expect(dir).toContain("n");
  }).pipe(
    // The standalone helper layered over the full runtime — last wins for
    // the Sandbox tag, proving the helper is composable.
    Effect.provide(layer),
    Effect.provide(sandboxLayer),
  );
});
