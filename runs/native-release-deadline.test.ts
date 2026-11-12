import { Effect, Exit } from "effect";
import { expect, it } from "vitest";
import {
  IO,
  NativeExecution,
  NativeReceiptRefused,
  type NativeExecutionService,
  type NativeRequest,
} from "@fractalboxdev/flare-dispatch-core";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { contextfulReleaseCell } from "./contextful-release";

for (const late of ["before observation", "during observation"]) {
  it(`refuses native release ready ${late} after the absolute deadline before reading or publishing artifacts`, async () => {
    const repo = "fractalboxdev/contextful",
      sha = "a".repeat(40);
    const profile = "contextful-edge",
      target = "x86_64-pc-windows-msvc";
    const runtime = makeCFRuntimeTest({
      sandboxProgram: { "release --plan": { exitCode: 0, stdout: `${profile} ${target}\n` } },
    });
    let clocks = 0,
      observations = 0,
      reads = 0,
      now = 0;
    const request: NativeRequest = {
      repo,
      head: sha,
      base: sha,
      profile,
      target,
      mode: "release",
      executor_ref: "b".repeat(40),
      nonce: "c".repeat(64),
      command_sha256: "d".repeat(64),
    };
    const native: NativeExecutionService = {
      admitRelease: () => Effect.succeed({ request }),
      observeRelease: () =>
        Effect.sync(() => {
          observations++;
          now = 14_400_001;
          return { status: "ready", files: [] };
        }),
      readReleaseFile: () =>
        Effect.suspend(() => {
          reads++;
          return Effect.fail(
            new NativeReceiptRefused({ reason: "metadata must not be read after deadline" }),
          );
        }),
    };
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const io = yield* IO;
        return yield* contextfulReleaseCell
          .run({ repo, sha, tag: "v0.5.0", profile, target, releaseId: 0, dryRun: true })
          .pipe(
            Effect.provideService(IO, {
              ...io,
              now: Effect.sync(() =>
                clocks++ === 0 ? 0 : late === "before observation" ? 14_400_001 : now,
              ),
            }),
            Effect.provideService(NativeExecution, native),
          );
      }).pipe(Effect.provide(runtime.layer)),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(JSON.stringify(result)).toContain("native release deadline exceeded");
    expect(observations).toBe(late === "before observation" ? 0 : 1);
    expect(reads).toBe(0);
    expect(runtime.handles.artifact.uploads).toHaveLength(0);
  });
}
