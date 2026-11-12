import { createHash } from "node:crypto";
import { Cause, Effect, Exit, Option } from "effect";
import { expect, it } from "vitest";
import {
  Github,
  GitHubApiError,
  NativeExecution,
  NativeExecutionUnavailable,
  StepRunner,
  type NativeRequest,
} from "@fractalboxdev/flare-dispatch-core";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { makeR2ArtifactLive } from "@fractalboxdev/flare-dispatch-runtime-cf/native";
import { makeTestBindings } from "@fractalboxdev/flare-dispatch-runtime-cf/testing";
import { contextfulReleaseCell } from "@fractalboxdev/flare-dispatch-runs";

for (const scenario of [403, 429, "budget"] as const) {
  it(`native release publication ${scenario} stages once and uses durable quota waits`, async () => {
    const raw = await makeTestBindings();
    const repo = "fractalboxdev/contextful",
      sha = "a".repeat(40);
    const profile = "contextful-edge",
      target = "x86_64-pc-windows-msvc";
    const name = `contextful-edge-0.5.0-${target}`;
    const archive = `${name}.tar.gz`,
      checksum = `${archive}.sha256`,
      sbom = `${name}.cdx.json`;
    const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const binary = new TextEncoder().encode(
      "fixture archive bytes, not a Windows acceptance result",
    );
    const files: Record<string, Uint8Array> = {
      [`dist/${name}.release.json`]: new TextEncoder().encode(
        JSON.stringify({ profile, target, archive, sha256: hash(binary), sbom }),
      ),
      [`dist/${archive}`]: binary,
      [`dist/${checksum}`]: new TextEncoder().encode(`${hash(binary)}  ${archive}\n`),
      [`dist/${sbom}`]: new TextEncoder().encode('{"bomFormat":"CycloneDX"}'),
    };
    const request: NativeRequest = {
      repo,
      head: sha,
      base: sha,
      profile,
      target,
      mode: "release",
      executor_ref: "b".repeat(40),
      dispatch_ref: "refs/tags/native-executor-v1",
      nonce: "c".repeat(64),
      command_sha256: "d".repeat(64),
    };
    const runtime = makeCFRuntimeTest({
      sandboxProgram: {
        "release --plan": {
          exitCode: 0,
          stdout: `contextful-control x86_64-unknown-linux-musl\n${profile} ${target}\n`,
        },
      },
    });
    const reads: string[] = [],
      calls: { name: string; reads: number }[] = [],
      sleeps: number[] = [];
    try {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const native = yield* NativeExecution,
            github = yield* Github,
            steps = yield* StepRunner;
          return yield* contextfulReleaseCell
            .run({ repo, sha, profile, target, tag: "v0.5.0", releaseId: 7, dryRun: false })
            .pipe(
              Effect.provideService(NativeExecution, {
                ...native,
                admitRelease: () => Effect.succeed({ request }),
                observeRelease: () => Effect.succeed({ status: "ready", files: [] }),
                readReleaseFile: (_, path) =>
                  Effect.sync(() => {
                    reads.push(path);
                    const bytes = files[path]!;
                    return {
                      body: new Response(bytes).body!,
                      size: bytes.length,
                      sha256: hash(bytes),
                    };
                  }),
              }),
              Effect.provideService(Github, {
                ...github,
                publishReleaseAsset: (input) =>
                  Effect.suspend(() => {
                    calls.push({ name: input.artifactName, reads: reads.length });
                    return scenario === "budget" || calls.length === 1
                      ? Effect.fail(
                          new GitHubApiError({
                            status: scenario === "budget" ? 403 : scenario,
                            reason: "rate-limited",
                            retryAfterMs: scenario === "budget" ? 1_200_000 : 700_965,
                          }),
                        )
                      : github.publishReleaseAsset(input);
                  }),
              }),
              Effect.provideService(StepRunner, {
                ...steps,
                sleep: (_, ms) =>
                  Effect.sync(() => {
                    sleeps.push(ms);
                  }),
              }),
              Effect.provide(makeR2ArtifactLive(raw.bucket, "native-publish-fixture")),
            );
        }).pipe(Effect.provide(NativeExecutionUnavailable), Effect.provide(runtime.layer)),
      );
      if (scenario === "budget") {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(Option.getOrUndefined(Cause.failureOption(exit.cause))).toMatchObject({
            _tag: "GitHubApiError",
            reason: "rate-limited",
          });
        expect(calls).toHaveLength(3);
        expect(sleeps).toEqual([1_215_000, 1_215_000]);
      } else {
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(calls.map((call) => call.name)).toEqual([archive, archive, checksum, sbom]);
        expect(sleeps).toEqual([715_965]);
      }
      // Two bounded metadata reads and three imports. Quota retries only read R2.
      expect(reads).toHaveLength(5);
      expect(calls[0]?.reads).toBe(5);
      for (const asset of [archive, checksum, sbom]) {
        const stored = await raw.bucket.get(`artifacts/native-publish-fixture/${asset}`);
        expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(files[`dist/${asset}`]);
      }
    } finally {
      await raw.dispose();
    }
  });
}
