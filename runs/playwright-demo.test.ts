// Run-level unit tests for the `playwright-demo` run.
//
// Drives the run Effect against the in-memory test runtime — no CF, no
// Docker, no browser, no network. The acceptance cases mirror the
// `offload-test` + `cdp-acceptance` shape, adapted to the run's
// "checkout → loadSecrets → exec → upload-video → upload-log" body:
//
//   (a) green   — fake spec exits 0 → output `.exitCode === 0`, the
//                  step records in order (loadSecrets is inline, not a
//                  step), the artifact bundle + log uploaded; with no
//                  video found, `videoUri` falls back to the bundle.
//   (a') video  — the locate-video `find` returns a path → the video is
//                  uploaded as its own artifact and `videoUri` diverges
//                  from `bundleUri`.
//   (b) red     — fake spec exits 1 → the run Effect *succeeds*
//                  (non-zero exit is a normal ExecResult), `.exitCode
//                  === 1`.
//   (c) timeout — the spec raises ExecTimeout → the run Effect *fails*
//                  with the `ExecTimeout` tag, re-failed unchanged.
//   (d) secrets — config-store secrets are resolved by `loadSecrets`
//                  and injected — as same-named env vars — into the
//                  test command, alongside the caller-provided `env`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { playwrightDemo } from "./playwright-demo";

const PLAYWRIGHT_COMMAND =
  "pnpm --filter @numu/qa exec playwright test --config qa/acceptance/playwright.demo.config.ts";

const baseInput = {
  repo: "owner/app",
  sha: "deadbeef",
  command: PLAYWRIGHT_COMMAND,
  artifactPath: ".tmp/demo-runs",
  secrets: [] as readonly string[],
} as const;

describe("playwright-demo", () => {
  it.effect(
    "green path — spec exits 0, bundle + log uploaded, videoUri falls back to bundle",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [PLAYWRIGHT_COMMAND]: { exitCode: 0 } },
      });

      return Effect.gen(function* () {
        const result = yield* playwrightDemo.run(baseInput);

        expect(result.exitCode).toBe(0);
        expect(result.logUri.length).toBeGreaterThan(0);
        // The fake's locate-video `find` returns empty stdout (no video on
        // disk) → the headline link degrades to the bundle, never dangles.
        expect(result.bundleUri.length).toBeGreaterThan(0);
        expect(result.videoUri).toBe(result.bundleUri);

        // checkout → run-playwright → locate-video → upload-bundle →
        // upload-log — loadSecrets is inline (no checkpoint), and with no
        // video found there is no upload-video step.
        expect(handles.executions.steps.map((s) => s.name)).toEqual([
          "checkout",
          "run-playwright",
          "locate-video",
          "upload-bundle",
          "upload-log",
        ]);
        expect(
          handles.executions.steps.every((s) => s.status === "success"),
        ).toBe(true);

        // Two artifact uploads — the bundle directory and the captured log.
        expect(handles.artifact.uploads).toHaveLength(2);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "video found — uploaded as its own artifact, videoUri diverges from bundleUri",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: {
          [PLAYWRIGHT_COMMAND]: { exitCode: 0 },
          // The locate-video `find` resolves the spec's recording.
          "find .tmp/demo-runs": {
            exitCode: 0,
            stdout:
              ".tmp/demo-runs/ci-123/demo-spec-chromium/video.webm\n",
          },
        },
      });

      return Effect.gen(function* () {
        const result = yield* playwrightDemo.run(baseInput);

        expect(result.exitCode).toBe(0);
        expect(result.videoUri.length).toBeGreaterThan(0);
        expect(result.videoUri).not.toBe(result.bundleUri);

        expect(handles.executions.steps.map((s) => s.name)).toEqual([
          "checkout",
          "run-playwright",
          "locate-video",
          "upload-bundle",
          "upload-video",
          "upload-log",
        ]);

        // Three uploads — bundle, the video file, and the captured log. The
        // video upload carries the streamable content type and the located
        // container path.
        expect(handles.artifact.uploads).toHaveLength(3);
        const video = handles.artifact.uploads.find(
          (u) => u.name === "video.webm",
        );
        expect(video?.contentType).toBe("video/webm");
        expect(video?.path).toContain(
          ".tmp/demo-runs/ci-123/demo-spec-chromium/video.webm",
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "red path — spec exits 1, output reports exitCode 1, Effect succeeds",
    () => {
      const { layer } = makeCFRuntimeTest({
        sandboxProgram: {
          [PLAYWRIGHT_COMMAND]: { exitCode: 1, stderr: "1 failing spec" },
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(playwrightDemo.run(baseInput));

        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
          expect(exit.value.exitCode).toBe(1);
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "timeout — spec raises ExecTimeout, the run re-fails with the same tag",
    () => {
      const { layer } = makeCFRuntimeTest({
        sandboxProgram: {
          [PLAYWRIGHT_COMMAND]: { fail: "ExecTimeout", timeoutSec: 1200 },
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(playwrightDemo.run(baseInput));

        expect(Exit.isFailure(exit)).toBe(true);
        const tag = Exit.isFailure(exit)
          ? Option.match(Cause.failureOption(exit.cause), {
              onSome: (f) => (f as { _tag?: string })._tag,
              onNone: () => undefined,
            })
          : undefined;
        expect(tag).toBe("ExecTimeout");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "secrets — loadSecrets resolves prefixed keys into the exec env",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [PLAYWRIGHT_COMMAND]: { exitCode: 0 } },
        config: {
          "staging/CF_ACCESS_CLIENT_ID": "id-123",
          "staging/CF_ACCESS_CLIENT_SECRET": "sk-456",
          "staging/STAGING_WEB_BASE": "https://example.pages.dev",
        },
      });

      return Effect.gen(function* () {
        const result = yield* playwrightDemo.run({
          ...baseInput,
          env: { DEMO_RUN_ID: "ci-2026-05-22" },
          secrets: [
            "CF_ACCESS_CLIENT_ID",
            "CF_ACCESS_CLIENT_SECRET",
            "STAGING_WEB_BASE",
          ],
          secretPrefix: "staging/",
        });

        expect(result.exitCode).toBe(0);

        // The exec recorded the merged env — resolved secrets surfaced
        // as bare env-var names (prefix stripped), plus the caller's
        // non-credential knob. Target the playwright exec by command:
        // the run also execs a locate-video `find` (no env injected).
        const execCall = handles.sandbox.execs.find((e) =>
          e.command.includes("playwright test"),
        );
        expect(execCall?.env?.CF_ACCESS_CLIENT_ID).toBe("id-123");
        expect(execCall?.env?.CF_ACCESS_CLIENT_SECRET).toBe("sk-456");
        expect(execCall?.env?.STAGING_WEB_BASE).toBe(
          "https://example.pages.dev",
        );
        expect(execCall?.env?.DEMO_RUN_ID).toBe("ci-2026-05-22");
      }).pipe(Effect.provide(layer));
    },
  );
});

// --- Source guard: no direct Date.now() / crypto.randomUUID() in the run -----
describe("playwright-demo source determinism", () => {
  it.effect("the run body never calls Date.now()/crypto.randomUUID()", () =>
    Effect.sync(() => {
      const src = readFileSync(
        fileURLToPath(new URL("./playwright-demo.ts", import.meta.url)),
        "utf8",
      );
      const code = src.replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/\bDate\s*\.\s*now\b/);
      expect(code).not.toMatch(/\bcrypto\s*\.\s*randomUUID\b/);
      expect(code).not.toMatch(/\bMath\s*\.\s*random\b/);
    }),
  );
});

// --- Source guard: the long `run-playwright` step has an EXPLICIT timeout -----
//
// Regression guard for the demo-on-merge failure: without a step-level
// `timeoutSec`, CF Workflows hard-kills the multi-minute exec at its 600s
// default (`WorkflowTimeoutError`) and retries it to exhaustion. The
// StepOpts → CF config mapping is unit-tested in `step-runner-cf.test.ts`; the
// inline test runner doesn't surface per-step opts, so we assert at the source
// level that the step is invoked with a timeout opt and `retries: 0`.
describe("playwright-demo step timeout", () => {
  it.effect("run-playwright passes a step-level timeoutSec + retries: 0", () =>
    Effect.sync(() => {
      const src = readFileSync(
        fileURLToPath(new URL("./playwright-demo.ts", import.meta.url)),
        "utf8",
      );
      // The step timeout is derived from the exec timeout plus headroom, capped
      // at the run's wall-clock ceiling — so it scales with `input.timeoutSec`
      // and can never outlive the run.
      expect(src).toMatch(
        /Math\.min\(\s*execTimeoutSec \+ STEP_TIMEOUT_HEADROOM_SEC,\s*MAX_DURATION_SEC,?\s*\)/,
      );
      // `run-playwright` is invoked with a step-opts literal carrying that
      // timeout and `retries: 0` — `retries` appears nowhere else in the run,
      // so this uniquely pins the long step's config.
      expect(src).toContain('step(\n        "run-playwright",');
      expect(src).toMatch(
        /\{\s*timeoutSec:\s*stepTimeoutSec,\s*retries:\s*0\s*\}/,
      );
    }),
  );

  it("runs on the lean sandbox image (its caller installs chromium)", () => {
    // Launches Playwright's own chromium inside the sandbox, but the CALLER's
    // command installs it (`playwright install …`) and the lean base carries
    // chromium's shared libs — so it stays on the always-provisioned lean
    // image rather than depending on a separately-built chromium-baked image.
    // Deliberately NOT via `requiresBrowser` (that's the CF Browser Rendering /
    // CDP axis); this run reserves no CDP slot. See define-run.ts § SandboxImage.
    expect(playwrightDemo.sandboxImage).toBe("lean");
    expect(playwrightDemo.limits.requiresBrowser).toBeUndefined();
  });
});
