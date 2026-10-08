import { Effect, Exit } from "effect";
import { expect, it } from "vitest";
import { IO, NativeExecution, NativeExecutionUnavailable, type NativeExecutionService } from "@fractalboxdev/flare-dispatch-core";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { nativeGate } from "./native-gate";

const input = { repo: "owner/project", sha: "1".repeat(40), baseSha: "2".repeat(40),
  target: "x86_64-pc-windows-msvc", checkLabel: "windows.x86_64-msvc" } as const;

it("refuses an observed result after the absolute recipe deadline", async () => {
  const runtime = makeCFRuntimeTest();
  let clocks = 0, observed = 0;
  const request = { repo: input.repo, head: input.sha, base: input.baseSha, target: input.target,
    executor_ref: "3".repeat(40), nonce: "4".repeat(64), mode: "gate" as const, profile: "" as const, command_sha256: "5".repeat(64) };
  const owner: NativeExecutionService = {
    ...await Effect.runPromise(NativeExecution.pipe(Effect.provide(NativeExecutionUnavailable))),
    admitGate: () => Effect.succeed({ request }),
    observeGate: () => Effect.sync(() => { observed++; return { status: "ready", files: [] }; }),
  };
  const result = await Effect.runPromiseExit(Effect.gen(function* () {
    const io = yield* IO;
    return yield* nativeGate.run(input).pipe(Effect.provideService(IO, { ...io,
      now: Effect.sync(() => clocks++ === 0 ? 0 : 14400001),
    }), Effect.provideService(NativeExecution, owner));
  }).pipe(Effect.provide(runtime.layer)));
  expect(Exit.isFailure(result)).toBe(true);
  expect(observed).toBe(0);
});

it("refuses missing configuration and mismatched target labels", async () => {
  const runtime = makeCFRuntimeTest();
  for (const checkLabel of [input.checkLabel, "windows.aarch64-msvc"] as const) {
    const result = await Effect.runPromiseExit(nativeGate.run({ ...input, checkLabel }).pipe(Effect.provide(runtime.layer)));
    expect(Exit.isFailure(result)).toBe(true);
  }
  expect(runtime.handles.sandbox.execs).toHaveLength(0);
});
