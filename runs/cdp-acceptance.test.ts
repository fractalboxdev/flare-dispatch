// Run-level unit tests for the `cdp-acceptance` run.
//
// Exercises the run Effect against the in-memory test runtime
// (`makeCFRuntimeTest` + `sandboxFakeProgram` + the Browser fake) — no CF, no
// Docker, no browser, no network. The acceptance cases mirror PR3's shape for
// `offload-test`, adapted to the browser-acceptance run:
//
//   (a) green   — fake test command exits 0 → output `.exitCode === 0`, the
//                  seven run-body steps each recorded once, the CDP session
//                  opened against the app port.
//   (b) red     — fake test command exits 1 → the run Effect *succeeds*
//                  (a non-zero exit is a normal ExecResult), `.exitCode === 1`.
//   (c) timeout — the test command raises ExecTimeout → the run Effect *fails*
//                  with the `ExecTimeout` tag, re-failed unchanged.
//   (d) secrets — config-store secrets are resolved by `loadSecrets` and
//                  injected — as same-named env vars — into BOTH the app boot
//                  and the test command, the latter alongside `CDP_WS_URL`.
//
// Spec: specs/pm/plan.md § V1 / V2 plan — PR9, specs/03-dsl.md § Unit-testing runs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Match, Option } from "effect";
import { describe, expect } from "vitest";
import {
  ExecFailed,
  type ExecResult,
  Sandbox,
  type SandboxService,
} from "@fractalboxdev/flare-dispatch-core";
import { makeCFRuntimeTest, makeSandboxFake } from "@fractalboxdev/flare-dispatch-core/testing";
import { cdpAcceptance, pollSentinelExit } from "./cdp-acceptance";

/**
 * A `Sandbox` Layer whose `exec` runs a scripted sequence — `"fail"` raises a
 * transient `ExecFailed` (a killed poll connection); any other entry is the
 * `cat <sentinel>` stdout. The last entry is sticky (so `["fail"]` = a
 * permanently dead container). `state.calls` lets a test assert the loop gave
 * up at the consecutive-failure ceiling rather than spinning to `maxAttempts`.
 * Only `exec` is implemented — `pollSentinelExit` touches nothing else.
 */
const scriptedSandbox = (script: ReadonlyArray<"fail" | string>) => {
  const state = { calls: 0 };
  const exec = (): Effect.Effect<ExecResult, ExecFailed> => {
    const entry = script[Math.min(state.calls, script.length - 1)];
    state.calls += 1;
    return entry === "fail"
      ? Effect.fail(
          new ExecFailed({
            exitCode: -1,
            stderrTail: "session shell exited — connection reset",
          }),
        )
      : Effect.succeed({
          exitCode: 0,
          durationMs: 1,
          logPath: "logs/fake/poll.ndjson",
          stdout: entry ?? "",
          stderr: "",
        });
  };
  return {
    layer: Layer.succeed(Sandbox, { exec } as unknown as SandboxService),
    state,
  };
};

const failureTag = (exit: Exit.Exit<unknown, unknown>): string | undefined =>
  Exit.isFailure(exit)
    ? Option.match(Cause.failureOption(exit.cause), {
        onSome: (f) => (f as { _tag?: string })._tag,
        onNone: () => undefined,
      })
    : undefined;

const baseInput = {
  repo: "owner/app",
  sha: "deadbeef",
  appBootCommand: "pnpm dev",
  appPort: 4173,
  testCommand: "pnpm test:acceptance",
  secrets: [] as readonly string[],
} as const;

describe("cdp-acceptance", () => {
  it.effect("green path — test command exits 0, eight steps, CDP attached", () => {
    const { layer, handles } = makeCFRuntimeTest({
      // The suite runs detached and writes `DONE:<exit>` to the sentinel;
      // `run-tests-wait` polls `cat <sentinel>` for it. Exit 0 = green.
      sandboxProgram: { "run-tests.done": { exitCode: 0, stdout: "DONE:0" } },
      browser: { wsEndpoint: "wss://test-cdp/abc" },
    });

    return Effect.gen(function* () {
      const result = yield* cdpAcceptance.run(baseInput);

      expect(result.exitCode).toBe(0);
      expect(result.reportUri.length).toBeGreaterThan(0);
      expect(result.screenshotsUri.length).toBeGreaterThan(0);

      // checkout → boot-app → expose-app → attach-cdp → run-tests-start →
      // run-tests-wait → upload-report → upload-screenshots, each recorded once,
      // all successful. The suite runs detached (`run-tests-start`) and its exit
      // is polled (`run-tests-wait`). `loadSecrets` is called inline (not a
      // step) so credentials never hit a checkpoint.
      expect(handles.executions.steps.map((s) => s.name)).toEqual([
        "checkout",
        "boot-app",
        "expose-app",
        "attach-cdp",
        "run-tests-start",
        "run-tests-wait",
        "upload-report",
        "upload-screenshots",
      ]);
      expect(
        handles.executions.steps.every((s) => s.status === "success"),
      ).toBe(true);

      // The app port was exposed to get a publicly-reachable URL.
      expect(handles.sandbox.exposed).toEqual([{ port: 4173, name: undefined }]);

      // The CDP session was opened against the *exposed* URL, not `localhost`
      // (the cloud browser cannot reach the container's localhost).
      expect(handles.browser.cdpSessions).toEqual([
        { targetUrl: "https://4173-fake-sandbox.example.com" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "red path — test command exits 1, the run FAILS with AcceptanceFailed",
    () => {
      const { layer } = makeCFRuntimeTest({
        // Suite finished with a non-zero exit (a failing spec). The cat exec
        // itself succeeds; the suite's code lives in the sentinel's `DONE:1`.
        sandboxProgram: { "run-tests.done": { exitCode: 0, stdout: "DONE:1" } },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(cdpAcceptance.run(baseInput));

        // A non-zero suite exit fails the run → the dispatcher reports a
        // `failure` check-run (was a false-green: a succeeding value).
        expect(Exit.isFailure(exit)).toBe(true);
        const tag = Exit.isFailure(exit)
          ? Option.match(Cause.failureOption(exit.cause), {
              onSome: (f) => (f as { _tag?: string })._tag,
              onNone: () => undefined,
            })
          : undefined;
        expect(tag).toBe("AcceptanceFailed");

        // The failure carries a short markdown summary linking the already-
        // uploaded report + screenshots bundles (issue #85), so the red
        // check-run points straight at the debugging artifacts.
        const summaryMd = Exit.isFailure(exit)
          ? Option.match(Cause.failureOption(exit.cause), {
              onNone: () => undefined,
              onSome: (failure) =>
                Match.value(failure).pipe(
                  Match.tag("AcceptanceFailed", (e) => e.summaryMd),
                  Match.orElse(() => undefined),
                ),
            })
          : undefined;
        expect(summaryMd).toBeDefined();
        expect(summaryMd).toContain("exited `1`");
        expect(summaryMd).toContain("[Playwright report](");
        expect(summaryMd).toContain("[Screenshots](");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "pollSentinelExit — returns the suite exit code parsed from the DONE sentinel",
    () => {
      const { layer } = makeSandboxFake({
        "run-tests.done": { exitCode: 0, stdout: "DONE:7" },
      });
      return Effect.gen(function* () {
        const code = yield* pollSentinelExit({
          container: { id: "c1" },
          dir: "/workspace/app",
          maxAttempts: 5,
          pollEvery: "1 millis",
        });
        expect(code).toBe(7);
      }).pipe(Effect.provide(layer));
    },
  );

  // Plain `it` (real clock) — the poll sleeps between attempts, and `it.effect`'s
  // TestClock would never advance them, hanging the test.
  it("pollSentinelExit — fails ExecTimeout when the sentinel never appears", async () => {
    // Empty program → `cat <sentinel>` returns no DONE line on every poll.
    const { layer } = makeSandboxFake({});
    const exit = await Effect.runPromise(
      Effect.exit(
        pollSentinelExit({
          container: { id: "c1" },
          dir: "/workspace/app",
          maxAttempts: 3,
          pollEvery: "1 millis",
        }).pipe(Effect.provide(layer)),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const tag = Exit.isFailure(exit)
      ? Option.match(Cause.failureOption(exit.cause), {
          onSome: (f) => (f as { _tag?: string })._tag,
          onNone: () => undefined,
        })
      : undefined;
    expect(tag).toBe("ExecTimeout");
  });

  // A killed POLL connection (the CF Sandbox kills container execs
  // non-deterministically) says nothing about the detached suite, which keeps
  // running and will still write the sentinel. A transient `ExecFailed` here
  // must NOT fail the run — swallow it and keep polling until the sentinel
  // lands. Regression for the `run-tests-wait → ExecFailed` aborts.
  it("pollSentinelExit — tolerates transient ExecFailed and returns the exit once the sentinel appears", async () => {
    const { layer, state } = scriptedSandbox(["fail", "fail", "DONE:0"]);
    const exit = await Effect.runPromise(
      Effect.exit(
        pollSentinelExit({
          container: { id: "c1" },
          dir: "/workspace/app",
          maxAttempts: 10,
          pollEvery: "1 millis",
          maxConsecutiveExecFailures: 5,
        }).pipe(Effect.provide(layer)),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(Exit.isSuccess(exit) ? exit.value : undefined).toBe(0);
    expect(state.calls).toBe(3); // two killed polls tolerated, third read the sentinel
  });

  // A genuinely dead container (every poll killed) must still fail the run —
  // and give up AT the ceiling, not spin to `maxAttempts`. Surfaces `ExecFailed`
  // (process could not run), distinct from the `ExecTimeout` sentinel-absent case.
  it("pollSentinelExit — surfaces ExecFailed after maxConsecutiveExecFailures killed polls (gives up early)", async () => {
    const { layer, state } = scriptedSandbox(["fail"]);
    const exit = await Effect.runPromise(
      Effect.exit(
        pollSentinelExit({
          container: { id: "c1" },
          dir: "/workspace/app",
          maxAttempts: 100,
          pollEvery: "1 millis",
          maxConsecutiveExecFailures: 3,
        }).pipe(Effect.provide(layer)),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureTag(exit)).toBe("ExecFailed");
    expect(state.calls).toBe(3); // stopped at the ceiling, not after 100 attempts
  });

  it.effect(
    "secrets — config-store values are injected into the boot + test env",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "run-tests.done": { exitCode: 0, stdout: "DONE:0" } },
        browser: { wsEndpoint: "wss://test-cdp/abc" },
        config: { "secret/CLERK_SECRET_KEY": "sk_live_x" },
      });
      const input = {
        ...baseInput,
        secrets: ["CLERK_SECRET_KEY"],
        secretPrefix: "secret/",
      };

      return Effect.gen(function* () {
        yield* cdpAcceptance.run(input);

        // The app boot gets the resolved secret.
        const boot = handles.sandbox.execs.find((e) => e.command === "pnpm dev");
        expect(boot?.env).toEqual({ CLERK_SECRET_KEY: "sk_live_x" });

        // The test command (now wrapped in the sentinel writer) gets the
        // secret, the CDP endpoint, and the publicly-reachable target URL.
        const test = handles.sandbox.execs.find((e) =>
          e.command.includes("pnpm test:acceptance"),
        );
        expect(test?.env).toEqual({
          CLERK_SECRET_KEY: "sk_live_x",
          CDP_WS_URL: "wss://test-cdp/abc",
          CDP_TARGET_URL: "https://4173-fake-sandbox.example.com",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "secrets — a named-but-unset secret fails the run with SecretsMissing",
    () => {
      // No `config` seed — the named secret resolves to nothing. `loadSecrets`
      // runs with `required: true`, so the run fails fast instead of booting
      // the app without the credential.
      const { layer } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test:acceptance": { exitCode: 0 } },
        browser: { wsEndpoint: "wss://test-cdp/abc" },
      });
      const input = { ...baseInput, secrets: ["CLERK_SECRET_KEY"] };

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(cdpAcceptance.run(input));

        expect(Exit.isFailure(exit)).toBe(true);
        const tag = Exit.isFailure(exit)
          ? Option.match(Cause.failureOption(exit.cause), {
              onSome: (f) => (f as { _tag?: string })._tag,
              onNone: () => undefined,
            })
          : undefined;
        expect(tag).toBe("SecretsMissing");
      }).pipe(Effect.provide(layer));
    },
  );
});

// --- Source guard: no direct Date.now() / crypto.randomUUID() in the run -----
// Per specs/pm/plan.md § 6 — the run body must not introduce non-determinism;
// replay-sensitive values come from checkpointed step results (or `io`).
describe("cdp-acceptance source determinism", () => {
  it.effect("the run body never calls Date.now()/crypto.randomUUID()", () =>
    Effect.sync(() => {
      const src = readFileSync(
        fileURLToPath(new URL("./cdp-acceptance.ts", import.meta.url)),
        "utf8",
      );
      const code = src.replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/\bDate\s*\.\s*now\b/);
      expect(code).not.toMatch(/\bcrypto\s*\.\s*randomUUID\b/);
      expect(code).not.toMatch(/\bMath\s*\.\s*random\b/);
    }),
  );
});
