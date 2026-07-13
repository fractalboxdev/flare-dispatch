// @fractalboxdev/flare-dispatch-runtime-cf — SandboxCloudflareLive: the live `sandbox` capability.
//
// Backs `SandboxService` with the Cloudflare Containers binding, via the
// `@cloudflare/sandbox` SDK. The SDK's `Sandbox` Durable Object wraps a
// container and exposes a typed `exec` / `gitCheckout` surface over RPC;
// `getSandbox(ns, id)` returns the client proxy. `RunSandbox` (apps/dispatcher)
// is a thin `extends Sandbox` so the binding resolves to a class wrangler can
// register as a Container.
//
// ============================================================================
// PR4-RISK — the flagged Containers-API surface (specs/pm/plan.md § 6)
// ============================================================================
//
// The plan flags `SandboxCloudflareLive` as "the most likely spot to discover a
// mismatch between the spec's Sandbox model and the real, evolving Containers
// API." Outcome of building it:
//
//   * `clone` + `exec` — the V0-critical surface — ARE fully implemented
//     against the current `@cloudflare/sandbox` (0.10.x) API. `exec` maps
//     1:1 to `sandbox.exec(command, { cwd, env, timeout })`; `git.clone` maps
//     to `sandbox.gitCheckout(url, { targetDir })` followed by a SHA checkout
//     `exec`. The narrow `SandboxService` Tag (clone, exec) is exactly the
//     small surface the plan's mitigation asked for.
//
//   * `acquire` is a no-op handle — the SDK has no explicit "acquire a
//     container" step: `getSandbox(ns, id)` lazily provisions the container on
//     the first `exec`/`gitCheckout`. The V0 model is one container per
//     execution (`id = executionId`), so `acquire` just returns that handle.
//
//   * `runDetached` / `waitForExit` / `waitForPort` — the detached-mode
//     surface `bootApp` rides on — landed in PR9, mapped onto the SDK's
//     `startProcess` / `Process.waitForExit` / `Process.waitForPort`. The V0
//     `Effect.die` stubs are gone: `cdp-acceptance` (V2) needs them.
//
// Container boot itself cannot be exercised in `vitest-pool-workers` (Miniflare
// has no container runtime without Docker), so the integration tests cover
// D1 / R2 / Workflow wiring; this Layer's `exec` / `clone` / detached mapping
// is verified by typecheck + `wrangler deploy --dry-run`. The end-to-end
// container smoke is a `wrangler dev` acceptance.
//
// Spec: specs/01-architecture.md § Sandbox, specs/03-dsl.md § sandbox.

import {
  getSandbox,
  type Sandbox,
  SessionTerminatedError,
} from "@cloudflare/sandbox";
import { Duration, Effect, Layer } from "effect";
import {
  CheckoutFailed,
  type Container,
  ContainerLaunchFailed,
  type DetachedHandle,
  ExecFailed,
  type ExecResult,
  ExecTimeout,
  type ExposeResult,
  ExposePortFailed,
  PortNeverOpened,
  ReadFileFailed,
  Sandbox as SandboxTag,
  type SandboxService,
} from "@fractalboxdev/flare-dispatch-core";
import { getInstallationToken } from "@fractalboxdev/flare-dispatch-github-app";
import type { ChecksGithubConfig } from "./checks-github";
import { previewSafeSandboxId } from "./preview-sandbox-id";
import { authenticateCloneUrl, repoUrl } from "./sandbox-clone-url";

/** Normalise a `command` (string | array) to a single shell string. */
const asCommand = (command: string | readonly string[]): string =>
  typeof command === "string" ? command : command.join(" ");

/**
 * Cap the stdout/stderr *preview* carried inline in the `ExecResult`. The FULL
 * output is always written to R2 (`logPath`); only this tail rides in the
 * step's RETURN VALUE — which Cloudflare Workflows checkpoints and re-reads on
 * every engine replay. A multi-MB inline blob (a verbose Playwright run, a
 * browser-download progress stream) bloats the checkpoint and, when the engine
 * soft-restarts a step, the replay deserialization trips "Worker exceeded CPU
 * time limit". Keeping the inline tail small bounds the checkpoint; the
 * artifact/log uploads still surface the complete output. Matches the
 * `ExecResult.stdout` contract: "last N KB inlined; full log streamed to R2".
 */
const INLINE_TAIL_CHARS = 16 * 1024;
const inlineTail = (s: string, viewerUrl?: string): string =>
  s.length <= INLINE_TAIL_CHARS
    ? s
    : `…[${s.length - INLINE_TAIL_CHARS} chars truncated — ${
        viewerUrl !== undefined ? `full log: ${viewerUrl}` : "full log in R2"
      }]…\n${s.slice(s.length - INLINE_TAIL_CHARS)}`;

/** The subset of the SDK's `ExecResult` this layer consumes. */
interface RawExecResult {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Detect the shell's "could not enter the working directory" failure.
 *
 * When an `exec`'s `cwd` (the cloned workspace) is GONE at run time — the
 * per-execution container was reaped/recycled between the checkpointed
 * `checkout` step and this `exec` step, leaving a fresh, empty filesystem — the
 * SDK's shell prints `Failed to change directory to '<cwd>'` and exits non-zero
 * WITHOUT ever running the command. That is an INFRA failure, not a command
 * result. Folding it into a normal `ExecResult` is actively misleading: a
 * `failOnNonZeroExit` run (`oxlint`, `offload-test`) then renders it as "oxlint
 * found lint violations" / "tests failed" — a red verdict on a run that never
 * executed. Detecting it here lets `exec` raise `ExecFailed` instead, so it
 * surfaces as a generic, retryable "execution failed" — never a phantom finding.
 *
 * Tight by construction: only when a `cwd` was requested, the command exited
 * non-zero, produced NO stdout, and the shell's directory-change error is on
 * stderr. A real command that itself printed such a line would still have
 * produced stdout or a zero exit. (`SANDBOX_SLEEP_AFTER` in apps/dispatcher
 * keeps the container warm across the inter-step gap so this rarely fires; this
 * is the honesty backstop for the residual eviction/replay cases.)
 */
export const isWorkingDirFailure = (
  r: { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
  cwd: string | undefined,
): boolean =>
  cwd !== undefined &&
  r.exitCode !== 0 &&
  r.stdout === "" &&
  /failed to change directory/i.test(r.stderr);

/**
 * Run a command and ALWAYS resolve to a result when the command *ran* —
 * regardless of its exit code or how its shell ended. Only a genuine
 * could-not-launch / timeout failure rejects (→ `ExecFailed`/`ExecTimeout`).
 *
 * The `@cloudflare/sandbox` SDK rejects `exec` in two cases that are really a
 * *completed* command, not an infra failure:
 *   - `CommandError` — the command exited non-zero (carries exitCode + the
 *     captured stdout/stderr).
 *   - `SessionTerminatedError` — the session's shell exited (the command ran
 *     `exit`, or its last process took the shell down). Carries the exitCode;
 *     stdout/stderr are gone with the session, but anything the command already
 *     wrote to disk (e.g. a Playwright `playwright-report/` + report.json) is
 *     intact for the run's artifact upload.
 *
 * Folding both back into a result is what lets a *failing* `playwright-demo`
 * still upload its `videoUri` (report/trace/video) and `logUri` instead of
 * dying with no output. A failing test is data, not an error.
 *
 * `CommandError` is not exported from the SDK package root, so it's matched by
 * `name` and its public getters (`exitCode`/`stdout`/`stderr`) are read off the
 * instance directly.
 */
const execToResult = async (
  box: Sandbox,
  cmd: string,
  opts: { cwd?: string; env?: Record<string, string>; timeoutSec?: number },
): Promise<RawExecResult> => {
  try {
    const r = await box.exec(cmd, {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeoutSec === undefined ? undefined : opts.timeoutSec * 1000,
    });
    return {
      exitCode: r.exitCode,
      durationMs: r.duration,
      stdout: r.stdout,
      stderr: r.stderr,
    };
  } catch (cause) {
    if (cause instanceof SessionTerminatedError) {
      return {
        exitCode: cause.exitCode ?? 1,
        durationMs: 0,
        stdout: "",
        stderr: `[session shell exited ${cause.exitCode ?? "?"} — stdout/stderr lost with the session; on-disk artifacts (report/trace/video) preserved]`,
      };
    }
    // `CommandError` (non-zero exit) — not exported, matched structurally.
    if (
      cause instanceof Error &&
      cause.name === "CommandError" &&
      typeof (cause as { exitCode?: unknown }).exitCode === "number"
    ) {
      const ce = cause as Error & {
        exitCode: number;
        stdout?: string;
        stderr?: string;
      };
      return {
        exitCode: ce.exitCode,
        durationMs: 0,
        stdout: ce.stdout ?? "",
        stderr: ce.stderr ?? "",
      };
    }
    throw cause; // genuine could-not-launch / timeout → classified by caller
  }
};


/**
 * Build the live `Sandbox` Layer bound to the Containers binding.
 *
 * One container per execution: the sandbox DO id is the `executionId`, so all
 * steps of one run share a filesystem. The R2 bucket is threaded so `exec`
 * streams each command's captured output to `logs/<execId>/<key>.ndjson` — the
 * `logPath` the `artifact.upload` step then promotes to a stable artifact URL.
 *
 * @param ns           the `RUNS_SANDBOX` DurableObjectNamespace<Sandbox>.
 * @param bucket       the R2 binding — exec log NDJSON sink.
 * @param executionId  the current execution; the sandbox id + R2 log prefix.
 * @param githubAuth   GitHub App credentials + installation id. When present,
 *                     `gitClone` authenticates the GitHub HTTPS clone URL with
 *                     a short-lived installation token so private repositories
 *                     are reachable. When absent, clones are unauthenticated
 *                     — the public-repo path is unchanged.
 * @param previewHostname  the Worker's public domain (e.g.
 *                     `flare-dispatch.<account>.workers.dev`) the SDK uses to
 *                     construct container preview URLs in `exposePort`. A
 *                     deploy-time property; absent, `exposePort` fails with
 *                     `ExposePortFailed` (the SDK cannot build a URL without it),
 *                     so a run that needs a reachable URL fails loudly rather
 *                     than handing the suite an unreachable `localhost`.
 */
export const makeSandboxCloudflareLive = (
  ns: DurableObjectNamespace<Sandbox>,
  bucket: R2Bucket,
  executionId: string,
  githubAuth?: ChecksGithubConfig,
  previewHostname?: string,
  /**
   * The tokened log-viewer base URL for this execution
   * (`https://<origin>/logs/<id>?t=<token>`). When set, the inline-truncation
   * breadcrumb in a checkpointed `ExecResult` points at the readable viewer
   * (deep-linked to the specific log file) instead of the dead-end "full log
   * in R2". `undefined` (no public origin / no log-link secret) keeps the
   * historical message. Built by the dispatcher (it owns the token secret).
   */
  logsViewerBase?: string,
): Layer.Layer<SandboxTag> => {
  // The Durable Object / sandbox id. `getSandbox` routes the DO by this id AND
  // the SDK embeds it in the `exposePort` preview URL's DNS label, which must
  // be lowercase `[a-z0-9-]` and short — so the raw `executionId`
  // (`<run>:<Owner>_<repo>:<sha>`) makes `expose-app` throw `ExposePortFailed`.
  // Normalise once and use the SAME value for every `getSandbox` call of this
  // run (here + the cache/artifact layers via the `acquire` handle below);
  // routing by a different id would resolve to a different container. R2 log
  // keys keep the raw `executionId` for traceability. See preview-sandbox-id.ts.
  const sandboxId = previewSafeSandboxId(executionId);

  // The per-execution sandbox client. `getSandbox` is cheap — the container is
  // provisioned lazily on first use — so resolving it once per Layer build is
  // correct (one container per execution).
  const box = getSandbox(ns, sandboxId);

  // `exec` log keys are unique within a run: the first exec is `exec.ndjson`
  // (the name the plan's acceptance pins), subsequent execs `exec-2.ndjson`, …
  let execSeq = 0;
  const nextLogKey = (): string => {
    execSeq += 1;
    return execSeq === 1
      ? `logs/${executionId}/exec.ndjson`
      : `logs/${executionId}/exec-${execSeq}.ndjson`;
  };

  /** Render captured stdout/stderr as NDJSON and stream it to R2. */
  const writeLog = async (
    key: string,
    command: string,
    stdout: string,
    stderr: string,
  ): Promise<void> => {
    const lines = [
      JSON.stringify({ stream: "meta", command }),
      ...stdout.split("\n").filter(Boolean).map((line) =>
        JSON.stringify({ stream: "stdout", line }),
      ),
      ...stderr.split("\n").filter(Boolean).map((line) =>
        JSON.stringify({ stream: "stderr", line }),
      ),
    ];
    await bucket.put(key, `${lines.join("\n")}\n`, {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
  };

  /**
   * Best-effort capture of a detached process's logs to R2 on a failure path
   * (a boot that never opened its port, a launch that threw). A detached boot
   * leaves no other diagnostic — without this the `steps` row's `log_uri` is
   * `null` and a failed boot is undebuggable. Returns the R2 `logPath` on
   * success, or `undefined` if logs could not be fetched (e.g. the process had
   * already vanished) — a capture failure must never mask the original error,
   * so every step is swallowed.
   */
  const captureDetachedLog = (
    handleId: string,
  ): Effect.Effect<string | undefined> =>
    Effect.promise(async () => {
      try {
        const proc = await box.getProcess(handleId);
        if (proc === null) return undefined;
        const logs = await proc.getLogs();
        const logPath = nextLogKey();
        await writeLog(logPath, proc.command, logs.stdout, logs.stderr);
        return logPath;
      } catch {
        return undefined;
      }
    });

  const service: SandboxService = {
    // No explicit acquire in the SDK — the container is provisioned lazily.
    // V0 = one container per execution; the handle is the normalised sandbox
    // id (NOT the raw executionId) so the cache + artifact layers, which call
    // `getSandbox(ns, container.id)`, route to the same DO as `box` above.
    acquire: () => Effect.succeed({ id: sandboxId } satisfies Container),

    gitClone: ({ repo, sha }) =>
      Effect.tryPromise({
        try: async () => {
          const targetDir = `/workspace/${repo.split("/").pop() ?? "repo"}`;
          // Authenticate the clone URL when GitHub App credentials are wired
          // (private-repo case). The token is short-lived (~1h) and never
          // leaves the Worker — it is embedded in the URL passed to the
          // sandbox's `gitCheckout`, which uses it once for the initial
          // fetch. Public repos and operator-supplied custom URLs skip the
          // rewrite (see `authenticateCloneUrl`).
          let cloneUrl = repoUrl(repo);
          if (githubAuth !== undefined) {
            const token = await getInstallationToken(githubAuth);
            cloneUrl = authenticateCloneUrl(cloneUrl, token);
          }
          await box.gitCheckout(cloneUrl, { targetDir });
          // `gitCheckout` clones a branch tip; pin the exact SHA so the run is
          // reproducible. A bare clone leaves the repo at the default branch.
          const checkout = await box.exec(`git checkout ${sha}`, {
            cwd: targetDir,
          });
          if (checkout.exitCode !== 0) {
            throw new Error(
              `git checkout ${sha} exited ${checkout.exitCode}: ${checkout.stderr}`,
            );
          }
          return targetDir;
        },
        catch: (cause) => new CheckoutFailed({ repo, sha, cause }),
      }),

    exec: ({ command, cwd, env, timeoutSec }) => {
      const cmd = asCommand(command);
      return Effect.tryPromise({
        // `tryPromise` failure path is `ExecFailed | ExecTimeout` — a command
        // that *could not run as a process*. A command that DID run — any exit
        // code, even one whose shell then exited — is a normal `ExecResult`,
        // folded back from the SDK's CommandError/SessionTerminatedError by
        // `execToResult` so a failing demo still uploads its report + log.
        try: async () => {
          const result = await execToResult(box, cmd, { cwd, env, timeoutSec });
          const logPath = nextLogKey();
          // FULL output → R2 (the durable log the artifact step promotes). Kept
          // even on the working-dir-missing path below, so the failure is
          // diagnosable from the log viewer.
          await writeLog(logPath, cmd, result.stdout, result.stderr);
          // A command whose shell could not even enter its working directory
          // never ran — the checkout did not survive to this exec (container
          // recycled between durable steps). Raise a real ExecFailed rather than
          // fold a phantom non-zero result a `failOnNonZeroExit` run would render
          // as a lint/test verdict (see `isWorkingDirFailure`). The throw is
          // classified by the `catch` below.
          if (isWorkingDirFailure(result, cwd)) {
            throw new Error(
              `working directory '${cwd}' was missing at exec time — the checkout did not survive to this step (container recycled). stderr: ${result.stderr.slice(0, 200)}`,
            );
          }
          // Only a bounded TAIL is inlined in the step's return value, so the
          // Workflow checkpoint stays small (see `inlineTail`). When a viewer
          // base is configured, the truncation breadcrumb deep-links to this
          // exec's log file in the readable viewer.
          const file = logPath.slice(logPath.lastIndexOf("/") + 1);
          const viewerUrl =
            logsViewerBase !== undefined
              ? `${logsViewerBase}#${file}`
              : undefined;
          return {
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            logPath,
            stdout: inlineTail(result.stdout, viewerUrl),
            stderr: inlineTail(result.stderr, viewerUrl),
          };
        },
        catch: (cause): ExecFailed | ExecTimeout => {
          // The SDK throws on timeout; classify by message, fall back to a
          // generic launch failure.
          const message = cause instanceof Error ? cause.message : String(cause);
          if (/timed?\s*out|timeout/i.test(message)) {
            return new ExecTimeout({
              timeoutSec: timeoutSec ?? 0,
              command: cmd,
            });
          }
          return new ExecFailed({ exitCode: -1, stderrTail: message });
        },
      });
    },

    // Full-content file read — the companion to `exec` for outputs larger
    // than the inlined stdout tail (see `inlineTail`). The SDK's `readFile`
    // streams the file over HTTP from the container, so multi-hundred-KB
    // text (a big `git diff --output`) arrives intact. The result is NOT
    // checkpointed here — bounding what flows into a Workflow checkpoint is
    // the CALLER's job (e.g. pr-review caps the diff inside its step).
    readFile: ({ path }) =>
      Effect.tryPromise({
        try: async () => {
          const result = await box.readFile(path);
          if (!result.success) {
            throw new Error(`readFile ${path} reported success=false`);
          }
          return result.content;
        },
        catch: (cause) =>
          new ReadFileFailed({
            path,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }),

    // Detached execution (PR9) — `bootApp`'s "start the app, return at once"
    // path. `startProcess` launches a long-running process; the run later
    // recovers it by id via `getProcess` to wait on its port / its exit.
    runDetached: ({ command, cwd, env, timeoutSec }) => {
      const cmd = asCommand(command);
      return Effect.tryPromise({
        try: async () => {
          const proc = await box.startProcess(cmd, {
            cwd,
            env,
            timeout: timeoutSec === undefined ? undefined : timeoutSec * 1000,
          });
          return {
            id: proc.id,
            container: { id: executionId },
          } satisfies DetachedHandle;
        },
        // No container image in scope here — the failure is a process-launch
        // failure, the closest tag the `SandboxService` contract offers.
        catch: (cause) => new ContainerLaunchFailed({ image: "", cause }),
      });
    },

    waitForExit: ({ handle }) =>
      Effect.tryPromise({
        try: async (): Promise<ExecResult> => {
          const startedAt = Date.now();
          const proc = await box.getProcess(handle.id);
          if (proc === null) {
            throw new Error(`detached process ${handle.id} not found`);
          }
          const exit = await proc.waitForExit();
          const logs = await proc.getLogs();
          const logPath = nextLogKey();
          await writeLog(logPath, proc.command, logs.stdout, logs.stderr);
          return {
            exitCode: exit.exitCode,
            durationMs: Date.now() - startedAt,
            logPath,
            stdout: logs.stdout,
            stderr: logs.stderr,
          };
        },
        // `waitForExit` only fails its Effect on a timeout / a vanished
        // process — a non-zero exit is a normal `ExecResult` above.
        catch: (cause): ExecTimeout =>
          new ExecTimeout({
            timeoutSec: 0,
            command: `detached:${handle.id} — ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          }),
      }),

    waitForPort: ({ handle, port, timeoutSec }) => {
      // The SDK's own `timeout` option is passed through, but it is not
      // reliably honored — in practice a hung boot blocks far past the ceiling
      // (a single attempt, not retries). Enforce the ceiling at the Effect
      // layer with `Effect.timeoutFail` so the wait fails fast at `timeoutSec`
      // regardless of SDK behavior.
      const sdkWait = Effect.tryPromise({
        try: async () => {
          const proc = await box.getProcess(handle.id);
          if (proc === null) {
            throw new Error(`detached process ${handle.id} not found`);
          }
          // TCP mode: the app is "up" once the port accepts connections — it
          // need not yet answer 2xx at `/`.
          await proc.waitForPort(port, {
            mode: "tcp",
            timeout:
              timeoutSec === undefined ? undefined : timeoutSec * 1000,
          });
        },
        catch: (): PortNeverOpened =>
          new PortNeverOpened({ port, timeoutSec: timeoutSec ?? 0 }),
      });

      const bounded =
        timeoutSec === undefined
          ? sdkWait
          : sdkWait.pipe(
              Effect.timeoutFail({
                duration: Duration.seconds(timeoutSec),
                onTimeout: () =>
                  new PortNeverOpened({ port, timeoutSec }),
              }),
            );

      // On any failure (SDK throw or the Effect-level timeout), best-effort
      // capture the detached process's logs and re-fail with the `logPath`
      // attached — the only diagnostic a failed detached boot leaves behind.
      return bounded.pipe(
        Effect.catchTag("PortNeverOpened", (err) =>
          captureDetachedLog(handle.id).pipe(
            Effect.flatMap((logPath) =>
              Effect.fail(
                new PortNeverOpened({
                  port: err.port,
                  timeoutSec: err.timeoutSec,
                  logPath,
                }),
              ),
            ),
          ),
        ),
      );
    },

    exposePort: ({ port, name }) =>
      previewHostname === undefined
        ? Effect.fail(
            new ExposePortFailed({
              port,
              cause:
                "no preview hostname configured — cannot construct a public URL",
            }),
          )
        : Effect.tryPromise({
            try: async (): Promise<ExposeResult> => {
              // The SDK builds the preview URL from the Worker's domain
              // (`hostname`) + the port; the process bound to the container's
              // `localhost:<port>` becomes reachable at the returned URL.
              const { url } = await box.exposePort(port, {
                hostname: previewHostname,
                name,
              });
              return { url };
            },
            catch: (cause) => new ExposePortFailed({ port, cause }),
          }).pipe(
            // The Workflow records only the tagged error; the underlying SDK
            // cause (e.g. `SandboxSecurityError: Preview URLs require lowercase
            // sandbox IDs`) is otherwise lost. Log it so a failed `expose-app`
            // is diagnosable from `wrangler tail` without DO-internal access.
            Effect.tapError((e) =>
              Effect.logError("exposePort failed", {
                port,
                sandboxId,
                previewHostname,
                cause: e.cause,
              }),
            ),
          ),
  };

  return Layer.succeed(SandboxTag, service);
};
