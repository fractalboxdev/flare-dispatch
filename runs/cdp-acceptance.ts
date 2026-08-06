// `cdp-acceptance` — the FlareDispatch V2 browser-acceptance run.
//
// Clones a repo, installs dependencies from the R2 cache, boots the app under
// test in a detached container, attaches Cloudflare Browser Rendering over the
// Chrome DevTools Protocol, runs the acceptance suite, and uploads the HTML
// report + a screenshots/trace bundle as artifacts. This is the run the
// roadmap's V2 exit criterion exercises (specs/pm/plan.md § roadmap).
//
// Contract — inputs/outputs per specs/02-runs.md § 4. Body shape per the
// recipe in recipes/cdp-acceptance/. The run rides on three primitives —
// `workspace` (acquire + clone + cached install), `loadSecrets` (config-store
// credential injection), and `bootApp` (detached run + wait-for-port) — so the
// body carries only the CDP-specific orchestration.
//
// --- Three design decisions, documented inline ------------------------------
//
// 1. Secrets are injected via `loadSecrets`, called INLINE (not in a `step`).
//    The migration target (a webapp's acceptance-cf job) needs `CLERK_*` /
//    `CLOUDFLARE_*` credentials to boot its dev servers. Rather than thread
//    them through GHA repo secrets and the dispatch payload, the operator
//    stores them in the FlareDispatch config store (KV); the run names the
//    keys in `inputs.secrets` and `loadSecrets` resolves them into the env
//    handed to BOTH the app boot and the test command. `loadSecrets` is called
//    inline, NOT wrapped in `step(...)`: a step return value is persisted to
//    the CF Workflow's durable checkpoint, and plaintext credentials must not
//    sit in Workflow state at rest. The config read is cheap + idempotent to
//    re-run on replay. `required: true` makes a missing key fail the run with
//    `SecretsMissing` rather than booting a credential-less container.
//
// 2. No `finalize` step — same boundary as `offload-test`.
//    The D1 `executions`-row status write and the GitHub check-run callback
//    are `RunWorkflow` plumbing, not run logic. The run records only its
//    steps; the Workflow records the execution. See runs/offload-test.ts
//    header note 1.
//
// 3. CDP target reachability is solved by exposing the app port.
//    `attach-cdp` hands the test command a `CDP_WS_URL` — the container's
//    Playwright process dials Cloudflare Browser Rendering directly (the
//    `/connect` WS endpoint, see @fractalboxdev/flare-dispatch-runtime-cf browser-cf.ts).
//    The *browser* runs in Cloudflare's cloud and cannot reach the container's
//    `localhost`, so a `localhost:<port>` target URL is unreachable. The
//    `expose-app` step calls `sandbox.exposePort(appPort)` to get a public
//    preview URL routing to the container and hands it to the suite as
//    `CDP_TARGET_URL` (alongside `CDP_WS_URL`). The suite navigates the browser
//    to `CDP_TARGET_URL`, not to `localhost`.
//
// Spec: specs/02-runs.md § 4, specs/03-dsl.md § browser + § Primitives,
//       specs/pm/plan.md § V1 / V2 plan — PR9.

import { Duration, Effect, Option, Schema } from "effect";
import {
  AcceptanceFailed,
  artifact,
  browser,
  type Container,
  defineRun,
  ExecFailed,
  type ExecResult,
  ExecTimeout,
  io,
  sandbox,
  step,
} from "@fractalboxdev/flare-dispatch-core";
import { bootApp, loadSecrets, workspace } from "@fractalboxdev/flare-dispatch-core/primitives";

/** Where `run-tests-start` writes the suite's `DONE:<exitcode>` sentinel. */
const SENTINEL_PATH = "/tmp/run-tests.done";
const SENTINEL_RE = /DONE:(-?\d+)/;

/**
 * Poll the detached suite's completion sentinel for its exit code.
 *
 * `run-tests-start` launches the suite as `( <testCommand> ); echo "DONE:$?" >
 * <sentinel>`, so the process writes its exit code to the sentinel when it
 * finishes (including when Playwright's own `globalTimeout` self-aborts it).
 * We poll with SHORT `cat` execs — each returns in well under the ~2-min window
 * that kills a long-lived blocking exec — instead of `sandbox.waitForExit`,
 * which does NOT reliably report a detached process's completion (it blocks
 * until the step timeout, which then retries and never resolves). Returns the
 * suite's exit code; fails `ExecTimeout` only if the sentinel never appears
 * within `maxAttempts` (the durable step's own timeout is the real ceiling).
 *
 * Transient-`ExecFailed` tolerance: a poll `cat` exec can have its container
 * connection killed (the CF Sandbox kills a container exec non-deterministically
 * — the very flake the detached+poll design exists to avoid for the *suite*).
 * A killed POLL connection says nothing about the detached suite, which keeps
 * running and will still write the sentinel — so a single `ExecFailed` here
 * must NOT fail the run. We swallow it, log, and keep polling. Only
 * `maxConsecutiveExecFailures` killed polls IN A ROW (a genuinely dead
 * container) re-surface the last `ExecFailed`, so a real outage still fails the
 * run instead of spinning silently to `maxAttempts`. A successful poll resets
 * the streak.
 */
export const pollSentinelExit = ({
  container,
  dir,
  sentinel = SENTINEL_PATH,
  pollEvery = "5 seconds",
  maxAttempts = 360,
  maxConsecutiveExecFailures = 12,
}: {
  readonly container: Container;
  readonly dir: string;
  readonly sentinel?: string;
  readonly pollEvery?: Duration.DurationInput;
  readonly maxAttempts?: number;
  readonly maxConsecutiveExecFailures?: number;
}) =>
  Effect.gen(function* () {
    let consecutiveExecFailures = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // `Option.none()` == this poll's exec connection was killed (transient).
      const polled = yield* sandbox
        .exec({
          cwd: dir,
          container,
          command: `cat ${sentinel} 2>/dev/null || true`,
        })
        .pipe(
          Effect.map(Option.some),
          // `Effect.logWarning` (built-in, no service requirement) — keeps this
          // helper's dependency surface at just `Sandbox`, so it stays unit-
          // testable with a bare Sandbox Layer. The run still threads `io.log`
          // for its own checkpointed lines.
          Effect.catchTag("ExecFailed", (cause: ExecFailed) =>
            Effect.logWarning(
              `run-tests-wait: poll exec killed (transient, ${consecutiveExecFailures + 1}/${maxConsecutiveExecFailures}), continuing`,
              { stderrTail: cause.stderrTail },
            ).pipe(Effect.as(Option.none<ExecResult>())),
          ),
        );

      if (Option.isNone(polled)) {
        consecutiveExecFailures += 1;
        if (consecutiveExecFailures >= maxConsecutiveExecFailures) {
          return yield* Effect.fail(
            new ExecFailed({
              exitCode: -1,
              stderrTail: `run-tests-wait: ${maxConsecutiveExecFailures} consecutive poll execs killed — container appears dead`,
            }),
          );
        }
        yield* Effect.sleep(pollEvery);
        continue;
      }

      consecutiveExecFailures = 0;
      const match = SENTINEL_RE.exec(polled.value.stdout);
      if (match) return Number(match[1]);
      yield* Effect.sleep(pollEvery);
    }
    return yield* Effect.fail(
      new ExecTimeout({
        timeoutSec: 0,
        command: `run-tests-wait: sentinel ${sentinel} never appeared after ${maxAttempts} polls`,
      }),
    );
  });

/** Input contract — specs/02-runs.md § 4. */
const CdpAcceptanceInput = Schema.Struct({
  repo: Schema.String, // "owner/name"
  sha: Schema.String,
  appBootCommand: Schema.String, // e.g. "pnpm dev" — may be multi-stage
  appPort: Schema.Number, // e.g. 4173
  testCommand: Schema.String, // e.g. "pnpm test:acceptance"
  /**
   * Config-store keys whose values are injected — as env vars of the same
   * name — into the app boot and the test command. Empty when the suite needs
   * no credentials. See `loadSecrets`.
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
});

/** Output contract — specs/02-runs.md § 4. */
const CdpAcceptanceOutput = Schema.Struct({
  exitCode: Schema.Number,
  reportUri: Schema.String, // signed R2 URL to the HTML report
  screenshotsUri: Schema.String, // signed R2 URL to the screenshots + trace bundle
});

/** Wait-for-port ceiling for the app boot, in seconds. */
const APP_BOOT_TIMEOUT_SEC = 120;

export const cdpAcceptance = defineRun({
  name: "cdp-acceptance",
  version: "1.0.0",

  inputs: CdpAcceptanceInput,
  outputs: CdpAcceptanceOutput,

  limits: {
    // Wall-time ceiling — specs/02-runs.md § 4. `requiresBrowser` selects a
    // runtime that wires the live Browser Rendering Layer.
    maxDurationSec: 1800,
    requiresBrowser: true,
  },

  run: (input) =>
    Effect.gen(function* () {
      // checkout — acquire a container, clone the SHA, install deps from the
      // R2-backed cache. The whole checkout dance is one primitive.
      const { container, dir } = yield* step("checkout", () =>
        workspace({ repo: input.repo, sha: input.sha, install: true }),
      );

      // load-secrets — resolve the named credentials from the config store
      // into the env injected below. Called INLINE, not in a `step`: secrets
      // must not land in a durable Workflow checkpoint (see header note 1).
      const secretEnv = yield* loadSecrets(input.secrets, {
        prefix: input.secretPrefix,
        required: true,
      });

      // boot-app — start the app in a detached container with the injected
      // secrets and block until its port opens.
      yield* step("boot-app", () =>
        bootApp({
          container,
          dir,
          command: input.appBootCommand,
          port: input.appPort,
          timeoutSec: APP_BOOT_TIMEOUT_SEC,
          env: secretEnv,
        }),
      );

      // expose-app — publish the app port as a public preview URL. The browser
      // runs in Cloudflare's cloud and cannot reach the container's
      // `localhost`; this is the reachable URL the suite navigates to (header
      // note 3). Handed to the test command as `CDP_TARGET_URL` below.
      const exposed = yield* step("expose-app", () =>
        sandbox.exposePort({ container, port: input.appPort }),
      );

      // attach-cdp — open a Browser Rendering CDP session. The step persists
      // ONLY the `wsEndpoint` string, not the whole `CDPSession`: the session
      // carries a `close` Effect, and a CF Workflow checkpoint cannot
      // structured-clone an Effect (`DataCloneError: … EffectPrimitiveSuccess`)
      // — every `step` return value is durably checkpointed. The suite never
      // closes the session (the container is torn down at run end), so the
      // endpoint the Playwright process connects over is all we carry across
      // the step boundary.
      const cdpWsUrl = yield* step("attach-cdp", () =>
        browser
          .newCDPSession({ targetUrl: exposed.url })
          .pipe(Effect.map((session) => session.wsEndpoint)),
      );

      // run-tests — run the acceptance suite DETACHED, then poll for its exit.
      // A non-zero exit code is a NORMAL ExecResult (a failing test), surfaced
      // to the output below — never an Effect failure. The suite writes
      // screenshots/traces under ./artifacts. `CDP_TARGET_URL` is the publicly-
      // reachable URL the suite navigates to; `CDP_WS_URL` is the Browser
      // Rendering endpoint the suite connects over.
      //
      // Why detached + sentinel-poll, not a blocking `sandbox.exec` or
      // `waitForExit`: a blocking exec holds one connection to the container for
      // the whole multi-minute remote-CDP run, and that connection is killed
      // non-deterministically (~2 min, ~25 min) → `ExecFailed`. `waitForExit`
      // avoids the kill but does NOT reliably report a detached process's exit —
      // it blocks until the step timeout, retries, and never resolves. So:
      //   - `run-tests-start` launches the suite DETACHED, wrapped to write its
      //     exit code to a sentinel file on completion:
      //         `( <testCommand> ); echo "DONE:$?" > <sentinel>`
      //     The subshell runs the suite (its trailing `exit $rc` sets `$?`); the
      //     parent shell records `DONE:<rc>` and exits. Playwright's own
      //     `globalTimeout` (consumer config) bounds the suite, so the sentinel
      //     is written even on a hung run.
      //   - `run-tests-wait` polls the sentinel with SHORT `cat` execs (each far
      //     under the ~2-min kill window), returning the exit code the moment it
      //     appears. No long-lived connection, so nothing to kill.
      yield* step(
        "run-tests-start",
        () =>
          sandbox.runDetached({
            cwd: dir,
            container,
            env: {
              ...secretEnv,
              CDP_WS_URL: cdpWsUrl,
              CDP_TARGET_URL: exposed.url,
            },
            command: `( ${input.testCommand} ); echo "DONE:$?" > ${SENTINEL_PATH}`,
          }),
        { retries: 0 },
      );
      const exitCode = yield* step("run-tests-wait", () => pollSentinelExit({ container, dir }), {
        timeoutSec: 1740,
        retries: 0,
      });

      // upload-report / upload-screenshots — promote both bundles to signed R2
      // URLs surfaced in the check-run summary.
      //
      // Best-effort: an artifact upload failure must NOT mask the test verdict.
      // The run's purpose is to report pass/fail (`exitCode`); the report +
      // screenshots are a debugging bonus. Previously a throwing `upload-report`
      // (e.g. an empty/oversized `playwright-report/`) aborted the run before
      // `exitCode` was recorded, so even a *passing* suite came back red with a
      // null summary. Catch upload failures, log them, and continue with an
      // empty URI so the verdict always lands.
      const uploadOrEmpty = (label: string, name: string, path: string) =>
        artifact
          .upload({ name, path, container, signedUrlTTL: "30 days" })
          .pipe(
            Effect.catchAll((cause) =>
              io.log("warn", `cdp-acceptance ${label} upload failed: ${cause}`).pipe(Effect.as("")),
            ),
          );

      const reportUri = yield* step("upload-report", () =>
        uploadOrEmpty("report", "acceptance-report", `${dir}/playwright-report/`),
      );
      const screenshotsUri = yield* step("upload-screenshots", () =>
        uploadOrEmpty("screenshots", "screenshots", `${dir}/artifacts/`),
      );

      yield* io.log("info", `cdp-acceptance exited ${exitCode}`);
      // A non-zero suite exit is a real test failure — fail the run so the
      // check-run conclusion is `failure`. Uploads above already ran, so the
      // report + screenshots are available for debugging the red run — and
      // the failure carries their links as `summaryMd` (issue #85) so the
      // red check-run points straight at them instead of a bare "failed".
      if (exitCode !== 0) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode,
            summaryMd: [
              `Test suite exited \`${exitCode}\`.`,
              // `<uri>/` is the browse entrypoint (the report's own
              // index.html / a generated listing); the bare uri stays the
              // .tar.gz download.
              ...(reportUri !== ""
                ? [`- [Playwright report](${reportUri}/) ([download](${reportUri}))`]
                : []),
              ...(screenshotsUri !== ""
                ? [`- [Screenshots](${screenshotsUri}/) ([download](${screenshotsUri}))`]
                : []),
            ].join("\n"),
          }),
        );
      }
      return { exitCode, reportUri, screenshotsUri };
    }),
});
