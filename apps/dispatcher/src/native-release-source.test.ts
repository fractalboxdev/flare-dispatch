import { Cause, Effect, Exit } from "effect";
import { expect, it } from "vitest";
import {
  ChildRuns,
  Github,
  NativeExecution,
  type SpawnChildRunOpts,
  type NativeRequest,
} from "@fractalboxdev/flare-dispatch-core";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { makeChildRunsLive } from "@fractalboxdev/flare-dispatch-runtime-cf/child-runs";
import { contextfulRelease } from "@fractalboxdev/flare-dispatch-runs";
import { makeNativeReleaseLayer } from "./native-release-layer";
import { makeFakeEnv, makeFakeWorkflow, makeFakeR2 } from "./test-helpers";

it("propagates an authenticated annotated tag's resolved commit through the real child payload into native admission", async () => {
  const repo = "fractalboxdev/contextful",
    tag = "v0.5.0";
  const tagObject = "a".repeat(40),
    commit = "b".repeat(40);
  const runtime = makeCFRuntimeTest({
    github: { files: { [`${repo}:Cargo.toml`]: '[workspace.package]\nversion = "0.5.0"\n' } },
    sandboxProgram: {
      "release --plan": { exitCode: 0, stdout: "contextful-edge x86_64-pc-windows-msvc\n" },
    },
  });
  const nativeWorkflow = makeFakeWorkflow();
  const env = {
    ...makeFakeEnv({
      workflow: nativeWorkflow,
      storage: makeFakeR2(),
      hmacSecret: "fixture",
      githubAppId: "42",
    }),
    GITHUB_APP_PRIVATE_KEY: "configured-test-key",
    NATIVE_WORKFLOW: nativeWorkflow.binding,
    NATIVE_EXECUTION_POLICY: JSON.stringify({
      repo,
      executor_ref: "c".repeat(40),
      dispatch_ref: "refs/tags/native-executor-v1",
      timeoutSec: 600,
      pollIntervalSec: 30,
    }),
  };
  const admitted: NativeRequest[] = [];
  const inherited = { repo, ref: `refs/tags/${tag}`, sha: tagObject, installationId: 99 };
  const live = makeChildRunsLive({
    db: {} as D1Database,
    parentExecutionId: "release-parent",
    github: inherited,
    workflow: {
      create: async ({ id, params }) => {
        const child = params as {
          github: { repo: string; sha: string };
          inputs: { sha: string; profile: "contextful-edge"; target: "x86_64-pc-windows-msvc" };
        };
        const owner = makeNativeReleaseLayer(env, {
          executionId: id,
          repo: child.github.repo,
          head: child.github.sha,
        });
        const handle = await Effect.runPromise(
          Effect.flatMap(NativeExecution, (service) =>
            service.admitRelease({
              head: child.inputs.sha,
              profile: child.inputs.profile,
              target: child.inputs.target,
            }),
          ).pipe(Effect.provide(owner)),
        );
        admitted.push(handle.request);
        return { id };
      },
    },
  });
  const result = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const github = yield* Github,
        fakeChildren = yield* ChildRuns;
      const actual = yield* ChildRuns.pipe(Effect.provide(live));
      return yield* contextfulRelease.run({ repo, tag, sha: tagObject, dryRun: false }).pipe(
        Effect.provideService(Github, {
          ...github,
          tagTarget: () => Effect.succeed({ refSha: tagObject, commitSha: commit }),
        }),
        Effect.provideService(ChildRuns, {
          ...fakeChildren,
          spawn: (opts: SpawnChildRunOpts) => actual.spawn(opts),
          // This fixture proves admission only; no native compiler verdict or release is fabricated.
          poll: ({ ids }) =>
            Effect.succeed(ids.map((executionId) => ({ executionId, status: "failure" as const }))),
        }),
      );
    }).pipe(Effect.provide(runtime.layer)),
  );
  expect(Exit.isFailure(result)).toBe(true);
  expect(Exit.isFailure(result) ? Cause.pretty(result.cause) : "").toContain(
    "AcceptanceFailed",
  );
  expect(admitted).toHaveLength(1);
  expect(admitted[0]).toMatchObject({ repo, head: commit, base: commit, mode: "release" });
  expect(nativeWorkflow.calls[0]?.params).toMatchObject({
    request: { head: commit, base: commit },
  });
  expect(inherited.sha).toBe(tagObject);
  expect(runtime.handles.github.publishReleaseCalls).toEqual([]);
});
