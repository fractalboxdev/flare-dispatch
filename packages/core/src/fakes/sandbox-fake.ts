// @fractalboxdev/flare-dispatch-core — Sandbox fake.
//
// In-memory stand-in for container execution. Records every `acquire` / `exec`
// / `gitClone` call and returns canned `ExecResult`s. `sandboxFakeProgram`
// matches the pattern sketched in specs/03-dsl.md § Unit-testing runs: a
// command→result map drives `exec` so a run test never boots a real container.
//
// Spec: specs/pm/plan.md § 3 (fakes/), specs/03-dsl.md § sandbox.

import { Effect, Layer } from "effect";
import { ContainerLaunchFailed, ExecFailed, ExecTimeout, ReadFileFailed } from "../errors";
import {
  type Container,
  type DetachedHandle,
  type ExecOpts,
  type ExecResult,
  Sandbox,
  type SandboxService,
} from "../services/sandbox";

/** A canned outcome for a matched command. */
export type CannedExec =
  | (Partial<ExecResult> & { readonly exitCode: number })
  | { readonly fail: "ExecFailed"; readonly exitCode?: number; readonly stderrTail?: string }
  | { readonly fail: "ExecTimeout"; readonly timeoutSec?: number };

/** Map of command-substring → canned outcome. */
export type CannedProgram = Record<string, CannedExec>;

/** Inspectable record of every call made to the fake. */
export type SandboxFakeState = {
  readonly acquired: { image?: string }[];
  readonly clones: { repo: string; sha: string }[];
  /** every `exec` / `runDetached` call — `env` lets tests assert injection. */
  readonly execs: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    /**
     * the effective timeout the run passed down. Recorded because a run may
     * resolve it from somewhere other than its own input (offload-test reads
     * `offload-test.timeoutSec:<repo>` from CONFIG_KV in webhook mode), and a
     * wrong value here is invisible in the command string — a timeout that is
     * too short kills a healthy run, and a NaN is a timeout that never fires.
     */
    timeoutSec?: number;
    /** the (redacted, per `redactValues`) returned stdout/stderr — absent on a canned failure. */
    stdout?: string;
    stderr?: string;
  }[];
  /** every `exposePort` call, in order — lets tests assert the port was exposed. */
  readonly exposed: { port: number; name?: string }[];
  /** every `readFile` call, in order. */
  readonly reads: { path: string }[];
};

const normalizeCommand = (command: string | readonly string[]): string =>
  typeof command === "string" ? command : command.join(" ");

/**
 * Default `durationMs` for a canned `ExecResult` when a program entry does not
 * pin one. Non-zero so a run test can meaningfully assert that the run threads
 * the `exec` step's checkpointed `durationMs` through to its output (the
 * replay-safe source — see runs/offload-test.ts). A `CannedExec` entry can
 * still override it with an explicit `durationMs`.
 */
const FAKE_DURATION_MS_DEFAULT = 1234;

const fullResult = (partial: Partial<ExecResult> & { exitCode: number }): ExecResult => ({
  exitCode: partial.exitCode,
  durationMs: partial.durationMs ?? FAKE_DURATION_MS_DEFAULT,
  logPath: partial.logPath ?? "logs/fake/exec.ndjson",
  stdout: partial.stdout ?? "",
  stderr: partial.stderr ?? "",
});

/** Mirrors the live layer's `redact` (sandbox-cf.ts) — see `ExecOpts.redactValues`. */
const redact = (text: string, values?: readonly string[]): string => {
  if (values === undefined || values.length === 0) return text;
  let out = text;
  for (const value of values) {
    if (value.length === 0) continue;
    out = out.split(value).join("***");
  }
  return out;
};

/**
 * Build a Sandbox fake from a canned command→result program plus an
 * inspectable state handle. `exec` finds the first program key that is a
 * substring of the command; an unmatched command yields exit 0.
 */
export const makeSandboxFake = (
  program: CannedProgram = {},
  /** path→content map answering `readFile`; an unseeded path fails. */
  files: Record<string, string> = {},
  /**
   * Transient `runDetached` launch failures, keyed by command-substring →
   * number of leading attempts to reject with `ContainerLaunchFailed` before
   * the launch succeeds. Models the CF Sandbox flaking a `startProcess` call
   * (the box is alive, the launch itself failed) so a run's launch-retry can be
   * exercised. Each matched key is counted down independently across calls.
   */
  launchFailures: Record<string, number> = {},
): { layer: Layer.Layer<Sandbox>; state: SandboxFakeState } => {
  const state: SandboxFakeState = {
    acquired: [],
    clones: [],
    execs: [],
    exposed: [],
    reads: [],
  };
  let containerSeq = 0;
  const detachedCommands = new Map<string, string>();
  // Mutable per-key countdown of remaining transient launch failures.
  const remainingLaunchFailures = new Map<string, number>(Object.entries(launchFailures));

  const resolve = (command: string): CannedExec | undefined => {
    const key = Object.keys(program).find((k) => command.includes(k));
    return key === undefined ? undefined : program[key];
  };

  const service: SandboxService = {
    acquire: (opts) =>
      Effect.sync(() => {
        state.acquired.push({ image: opts.image });
        containerSeq += 1;
        return { id: `fake-container-${containerSeq}` } satisfies Container;
      }),

    gitClone: ({ repo, sha }) =>
      Effect.sync(() => {
        state.clones.push({ repo, sha });
        return `/workspace/${repo.split("/").pop() ?? "repo"}`;
      }),

    exec: (opts: ExecOpts) => {
      const command = normalizeCommand(opts.command);
      const entry: SandboxFakeState["execs"][number] = {
        command,
        cwd: opts.cwd,
        env: opts.env,
        timeoutSec: opts.timeoutSec,
      };
      state.execs.push(entry);
      const canned = resolve(command);
      if (canned && "fail" in canned) {
        return canned.fail === "ExecTimeout"
          ? Effect.fail(
              new ExecTimeout({
                timeoutSec: canned.timeoutSec ?? opts.timeoutSec ?? 600,
                command,
              }),
            )
          : Effect.fail(
              new ExecFailed({
                exitCode: canned.exitCode ?? 1,
                stderrTail: canned.stderrTail ?? "",
              }),
            );
      }
      const result = fullResult(canned ?? { exitCode: 0 });
      const stdout = redact(result.stdout, opts.redactValues);
      const stderr = redact(result.stderr, opts.redactValues);
      entry.stdout = stdout;
      entry.stderr = stderr;
      return Effect.succeed({ ...result, stdout, stderr });
    },

    // Mirrors the live layer: a seeded path returns its content, anything
    // else fails — so a run that forgets to write the file before reading it
    // fails the same way in tests as in prod.
    readFile: ({ path }) => {
      state.reads.push({ path });
      const content = files[path];
      return content === undefined
        ? Effect.fail(new ReadFileFailed({ path, message: "no such file in fake" }))
        : Effect.succeed(content);
    },

    runDetached: (opts: ExecOpts) =>
      Effect.suspend(() => {
        const command = normalizeCommand(opts.command);
        // A transient launch failure rejects WITHOUT recording the exec or
        // minting a handle — the process never started, exactly as a real
        // `ContainerLaunchFailed` leaves no detached process behind. The
        // caller's retry then re-invokes `runDetached`, counting this key down.
        const failKey = Object.keys(launchFailures).find((k) => command.includes(k));
        if (failKey !== undefined) {
          const remaining = remainingLaunchFailures.get(failKey) ?? 0;
          if (remaining > 0) {
            remainingLaunchFailures.set(failKey, remaining - 1);
            return Effect.fail(
              new ContainerLaunchFailed({
                image: "",
                cause: `fake transient launch failure (${remaining} left)`,
              }),
            );
          }
        }
        state.execs.push({ command, cwd: opts.cwd, env: opts.env });
        containerSeq += 1;
        const id = `fake-detached-${containerSeq}`;
        // Remember the command behind this handle so `waitForExit` can resolve
        // the same canned program entry `exec` would.
        detachedCommands.set(id, command);
        return Effect.succeed({
          id,
          container: { id: `fake-container-${containerSeq}` },
        } satisfies DetachedHandle);
      }),

    // Resolve the canned program for the detached command (the same entry
    // `exec` uses), so a program can drive a detached run's exit code / timeout.
    // `waitForExit`'s only failure is `ExecTimeout`; a canned `ExecFailed`
    // becomes a non-zero `ExecResult` (the process ran, then exited non-zero).
    waitForExit: ({ handle }) => {
      const command = detachedCommands.get(handle.id) ?? "";
      const canned = resolve(command);
      if (canned && "fail" in canned) {
        return canned.fail === "ExecTimeout"
          ? Effect.fail(
              new ExecTimeout({
                timeoutSec: canned.timeoutSec ?? 600,
                command,
              }),
            )
          : Effect.succeed(fullResult({ exitCode: canned.exitCode ?? 1 }));
      }
      return Effect.succeed(fullResult(canned ?? { exitCode: 0 }));
    },

    waitForPort: () => Effect.void,

    // Deterministic preview URL so a run test can assert the reachable URL is
    // threaded to the suite without booting a real container.
    exposePort: ({ port, name }) =>
      Effect.sync(() => {
        state.exposed.push({ port, name });
        return { url: `https://${port}-fake-sandbox.example.com` };
      }),
  };

  return { layer: Layer.succeed(Sandbox, service), state };
};

/**
 * A canned Sandbox fake Layer driven by a command→result program. The helper
 * sketched in specs/03-dsl.md § Unit-testing runs — `sandboxFakeProgram({ "pnpm
 * test": { exitCode: 1 } })`. The inspectable state is dropped; tests that need
 * it call `makeSandboxFake` directly.
 */
export const sandboxFakeProgram = (program: CannedProgram): Layer.Layer<Sandbox> =>
  makeSandboxFake(program).layer;

/** A ready-to-use Sandbox fake Layer with an empty program (all execs exit 0). */
export const SandboxFake: Layer.Layer<Sandbox> = makeSandboxFake().layer;
