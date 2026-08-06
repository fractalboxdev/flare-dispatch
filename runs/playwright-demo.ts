// `playwright-demo` — record a Playwright walkthrough of a deployed surface.
//
// Targets a hosted environment (preview / staging / prod) and runs a
// Playwright spec that captures a narrated video.webm + trace.zip + JSON
// report. No app boot — the site is already live; the test connects out
// over HTTPS (the spec is responsible for any auth header injection,
// e.g. Cloudflare Access service-token pairs read out of the env). After
// the test finishes, the run uploads the recorded video.webm as its own
// streamable artifact (the headline `videoUri` — plays in the browser)
// plus the whole artifacts directory as one tarball (`bundleUri`), so a
// reviewer clicks straight to the video without extracting an archive.
//
// Sits between `offload-test` (clone-and-run; no artifact upload beyond
// the step log) and `product-demo` (AI-driven, rrweb-recorded, requires
// the bundled `demo-agent` image). The pragmatic middle: today's
// consumers already author Playwright specs with `video: "on"`, so a run
// that just executes them and surfaces the resulting media bundle is the
// shortest path from "I have a demo spec" to "stakeholders can click a
// URL". Use `product-demo` when prose-driven LLM walkthroughs are
// preferred; use `playwright-demo` when a hand-authored spec is the
// source of truth.
//
// --- Three design decisions, documented inline ------------------------------
//
// 1. No app boot, no CDP.
//    `cdp-acceptance` boots a server in-container and attaches Browser
//    Rendering over CDP because its target is a fresh build of the repo.
//    `playwright-demo` runs against a DEPLOYED URL, so neither the boot
//    nor the CDP attach is wanted — Playwright launches its own bundled
//    Chromium inside the container and connects out to the deployed
//    surface directly. `requiresBrowser: false` accordingly: no Browser
//    Rendering slot is reserved.
//
// 2. Secrets via `loadSecrets`, called INLINE (not in a `step`).
//    Same constraint as `cdp-acceptance` (see its header note 1). The
//    typical caller passes the staging-tier secrets the local
//    `/demo-e2e`-style skill needs — Cloudflare Access service-token
//    pair, Clerk publishable + secret keys, the deployed base URL —
//    namespaced under `staging/` (or whichever prefix the operator
//    chose). Plaintext must not land in the Workflow checkpoint, so the
//    primitive is invoked inline.
//
// 3. `artifactPath` is a directory, not a glob — plus one located video.
//    `artifact.upload` tars directories and hands back one signed URL;
//    reviewers get the whole `playwright-report/` or `.tmp/demo-runs/`
//    tree (video + JSON report + screenshots) as `bundleUri`. On top of
//    that the run `find`s the spec's recorded `video.webm` and uploads it
//    as its own single-file artifact: the headline `videoUri` then streams
//    in the browser (`video/webm`) instead of forcing an archive download
//    — stakeholders click the email link to WATCH the demo. When no video
//    exists (spec crashed before recording), `videoUri` falls back to the
//    bundle so the link never dangles.
//
// Spec: specs/02-runs.md § 1 (input/output framing), specs/03-dsl.md §
//       Top-level shape + § sandbox + § artifact + § Primitives.

import { Effect, Schema } from "effect";
import { artifact, defineRun, io, sandbox, step } from "@fractalboxdev/flare-dispatch-core";
import { loadSecrets, workspace } from "@fractalboxdev/flare-dispatch-core/primitives";

/** Input contract — mirrors `offload-test` + `cdp-acceptance`. */
const PlaywrightDemoInput = Schema.Struct({
  repo: Schema.String, // "owner/name"
  sha: Schema.String,
  /**
   * The shell command that runs the Playwright spec. Single string so
   * the caller can chain its own `playwright install --with-deps
   * chromium` ahead of the test invocation — the run does NOT install
   * Playwright browsers for the caller, because browser-install needs
   * vary per spec (chromium-only vs all-browsers, --with-deps or not).
   */
  command: Schema.String,
  /**
   * Directory (relative to the repo root) the run tars + uploads after
   * the command exits. Typically the Playwright `outputDir` — e.g.
   * `.tmp/demo-runs` or `playwright-report`. The path must exist when
   * the command finishes; missing-directory failures surface as
   * `ArtifactUploadFailed`.
   */
  artifactPath: Schema.String,
  /**
   * Additional env vars injected alongside the resolved secrets. Use
   * for non-credential knobs the spec reads (e.g. `DEMO_RUN_ID`,
   * `DEMO_SLOW_MO_MS`). Credentials go through `secrets` + the
   * config store, not this field, so they don't end up in the
   * dispatch payload.
   */
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  /**
   * Config-store keys whose values are injected — as env vars of the
   * same name — into the test command. Empty when the spec needs no
   * credentials. Resolved via `loadSecrets` (see header note 2).
   *
   * @deprecated ADR-0006 — a value in the command's env is a long-lived
   * credential reachable from inside the container, and redaction only keeps it
   * out of the log. Migrate to worker-side writeback or to a grant profile whose
   * credential the substrate's egress handler attaches
   * (apps/substrate/specs/credential-boundary.md); removed at stage-2 exit.
   */
  secrets: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
  /**
   * Prefix prepended to each `secrets` key for the config lookup.
   *
   * @deprecated Ignored by `loadSecrets` (Worker bindings are bare names), and
   * removed with `secrets` at the substrate stage-2 exit (ADR-0006).
   */
  secretPrefix: Schema.optional(Schema.String),
  /** Wall-clock ceiling for the test command. Default 1200s. */
  timeoutSec: Schema.optional(Schema.Number),
});

/** Output contract. `videoUri` points at the video FILE itself (streams
 * in-browser as `video/webm`) when the spec produced one — a stakeholder
 * clicking the email/check-run link should watch the demo, not download an
 * archive. `bundleUri` is the whole-`artifactPath` tarball (video + report +
 * screenshots); `videoUri` falls back to it when no video was found. */
const PlaywrightDemoOutput = Schema.Struct({
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  videoUri: Schema.String, // signed R2 URL to the video file (or the tarball fallback)
  bundleUri: Schema.String, // signed R2 URL to the `artifactPath` tarball
  logUri: Schema.String, // signed R2 URL to the captured stdout/stderr
});

/** Default `exec` timeout when the caller omits `timeoutSec`. */
const TIMEOUT_SEC_DEFAULT = 1200;

/**
 * Headroom added to the `exec` timeout to derive the Workflow STEP timeout.
 *
 * The `run-playwright` step wraps a `sandbox.exec` that legitimately runs for
 * many minutes — `playwright install --with-deps chromium` plus a slowMo'd,
 * video-recording walkthrough. CF Workflows caps every `step.do` at a 10-minute
 * default unless a `timeout` is set (see runtime-cf `buildStepConfig`), so
 * without an explicit step timeout the platform hard-kills the exec at 600s with
 * `WorkflowTimeoutError`, retries it to exhaustion, and the run never produces
 * output. We give the STEP a timeout slightly longer than the EXEC's so the
 * sandbox's own deadline fires first (yielding a clean `ExecTimeout`/`ExecResult`
 * the run can report) instead of an opaque platform kill. Capped below
 * `maxDurationSec` so the step can never outlive the run's wall-clock ceiling.
 */
const STEP_TIMEOUT_HEADROOM_SEC = 120;

/** Run wall-clock ceiling — also the upper bound on any single step's timeout. */
const MAX_DURATION_SEC = 1800;

export const playwrightDemo = defineRun({
  name: "playwright-demo",
  version: "1.0.0",

  // Runs on the LEAN sandbox image (RUNS_SANDBOX). This run launches
  // Playwright's OWN bundled chromium INSIDE the container, but it does NOT bake
  // the browser into the image: the input contract (see `command` below) makes
  // the CALLER install its browser (`playwright install …`), and the lean base
  // already carries chromium's shared libs, so a headless launch works without
  // `--with-deps`. Keeping this on lean means the run depends only on the
  // always-provisioned default container, not on a separate chromium-baked
  // image that a `versions upload` (vs `wrangler deploy`) can leave unbuilt — a
  // missing container fails the FIRST RPC (the checkout clone) with an opaque
  // `CheckoutFailed` after cold-start CPU-limit thrash. The optional
  // `sandboxImage: "browser"` route stays available for a future run whose
  // command DROPS the install and relies on a baked browser; this one doesn't.
  // `requiresBrowser` is absent (false): no CF Browser Rendering / CDP slot.
  sandboxImage: "lean",

  inputs: PlaywrightDemoInput,
  outputs: PlaywrightDemoOutput,

  limits: {
    // 30-min wall-time ceiling — the typical demo spec runs in 60-180s
    // but `pnpm install` + `playwright install --with-deps chromium`
    // dominate on a cold container, and a flaky deploy can stretch the
    // first navigation. No Browser Rendering slot is reserved — see
    // header note 1.
    maxDurationSec: MAX_DURATION_SEC,
  },

  run: (input) =>
    Effect.gen(function* () {
      // checkout — acquire a container, clone the SHA, run the cached
      // pnpm install. The whole checkout dance is one primitive.
      const { container, dir } = yield* step("checkout", () =>
        workspace({ repo: input.repo, sha: input.sha, install: true }),
      );

      // load-secrets — resolve named credentials from the config store
      // into the env injected into the test command. Inline, not in a
      // `step` (see header note 2). `required: true` fails the run with
      // `SecretsMissing` rather than running a credential-less demo.
      const secretEnv = yield* loadSecrets(input.secrets, {
        prefix: input.secretPrefix,
        required: true,
      });

      // run-playwright — execute the test command. A non-zero exit is a
      // NORMAL ExecResult (a failing spec), surfaced to the output below
      // — never an Effect failure. The injected env merges the resolved
      // secrets with the caller-provided `env` (non-credential knobs
      // like `DEMO_RUN_ID`); secrets win on key collision so a typo in
      // `env` cannot shadow the real credential.
      //
      // The step carries an EXPLICIT timeout (see `STEP_TIMEOUT_HEADROOM_SEC`)
      // so the multi-minute command isn't hard-killed at CF's 10-minute step
      // default. `retries: 0` because a demo that fails or times out should
      // report that once — not be re-run five times over an hour (which is
      // exactly what the bare default produced).
      const execTimeoutSec = input.timeoutSec ?? TIMEOUT_SEC_DEFAULT;
      const stepTimeoutSec = Math.min(execTimeoutSec + STEP_TIMEOUT_HEADROOM_SEC, MAX_DURATION_SEC);
      const exec = yield* step(
        "run-playwright",
        () =>
          sandbox.exec({
            cwd: dir,
            container,
            env: { ...input.env, ...secretEnv },
            command: input.command,
            timeoutSec: execTimeoutSec,
          }),
        { timeoutSec: stepTimeoutSec, retries: 0 },
      );

      // locate-video — find the video file the spec recorded, so it can be
      // uploaded as its OWN artifact below. Playwright writes one
      // `video.webm` per test-result directory under `outputDir`; `sort`
      // makes the pick deterministic when a multi-test spec produced
      // several. A non-zero exit or empty stdout (no video — e.g. the spec
      // crashed before recording) is NOT a failure: `videoUri` falls back
      // to the bundle tarball.
      const locate = yield* step("locate-video", () =>
        sandbox.exec({
          cwd: dir,
          container,
          command: `find ${input.artifactPath} -type f -name video.webm | sort | head -n 1`,
          timeoutSec: 60,
        }),
      );
      const videoRelPath = locate.exitCode === 0 ? locate.stdout.trim() : "";

      // upload-bundle — promote the whole artifact directory (video.webm +
      // report.json + any screenshots) to a signed R2 URL. The `artifact`
      // capability tars directories — and expands the archive into per-file
      // R2 objects, so `<bundleUri>/` browses the tree.
      const bundleUri = yield* step("upload-bundle", () =>
        artifact.upload({
          name: "demo-bundle",
          path: `${dir}/${input.artifactPath}/`,
          container,
          contentType: "application/x-tar",
          signedUrlTTL: "30 days",
        }),
      );

      // upload-video — the video file as its own single-file artifact
      // (`artifact.upload` streams regular files un-tarred), so the headline
      // `videoUri` link plays in the browser instead of downloading an
      // archive the reviewer has to extract.
      const videoUri =
        videoRelPath === ""
          ? bundleUri
          : yield* step("upload-video", () =>
              artifact.upload({
                name: "video.webm",
                path: `${dir}/${videoRelPath}`,
                container,
                contentType: "video/webm",
                signedUrlTTL: "30 days",
              }),
            );

      // upload-log — push the captured stdout/stderr to R2. Reviewers
      // open this when the demo failed and they need to see what
      // Playwright printed before the video cut off.
      const logUri = yield* step("upload-log", () =>
        artifact.upload({
          name: "playwright.log",
          path: exec.logPath,
          signedUrlTTL: "30 days",
        }),
      );

      yield* io.log("info", `playwright-demo exited ${exec.exitCode} (${exec.durationMs}ms)`);

      return {
        exitCode: exec.exitCode,
        durationMs: exec.durationMs,
        videoUri,
        bundleUri,
        logUri,
      };
    }),
});
