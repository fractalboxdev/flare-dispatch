// `GateExec`: the one interface through which a gate job reaches a workspace and a command. mameko's `Exec` and
// `Workspace` Layers (MAMEKO-RUN-040 to MAMEKO-RUN-043) replace `processGateExec` once they exist; every recipe
// depends on the interface only.
//
// `processGateExec` runs a command, through `/bin/sh -c` or as an argv with no shell, as a supervised child process. The child leads its own process group, so a timeout
// or a stopped runner kills everything the command started. Its output reaches the runner's stderr: the runner's
// stdout carries only the result line, and any other line there loses the result (MAMEKO-EXEC-144).
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Data, Effect, Layer, Schema, type Scope } from "effect";

/** The most combined stdout and stderr one command may write (FD-GATE-008). */
export const OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;

/** How long a command has to exit after SIGTERM, before SIGKILL. */
const KILL_GRACE_MS = 5_000;

export type CommandExit = Data.TaggedEnum<{
  Exited: { readonly code: number };
  Signalled: { readonly signal: string };
  /** The job timeout passed. */
  TimedOut: {};
  /** The execution's `deadline_at` passed (FD-GATE-007). */
  DeadlineReached: {};
  OverLimit: {};
  NotStarted: { readonly detail: string };
}>;
export const CommandExit = Data.taggedEnum<CommandExit>();

export interface CommandOptions {
  /** Run through `/bin/sh -c`. */
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** The execution's `deadline_at`, epoch milliseconds; the command stops there whatever its timeout. */
  readonly deadlineAt?: number;
  readonly outputLimitBytes?: number;
  /**
   * Where set, the command's output reaches the runner's log only once the command ends, as `logAs` rewrites it, and
   * never as it is written. A scan withholds a scanner's matched values from the log this way (FD-GATE-098).
   */
  readonly logAs?: (output: Uint8Array) => Uint8Array;
}

/**
 * A command run as an argv with no shell: `argv[0]` is the binary, looked up on the `PATH` of `env`, and every other
 * element reaches it as one argument, so no element is word-split, globbed or expanded.
 */
export interface ArgvOptions extends Omit<CommandOptions, "command"> {
  readonly argv: readonly [string, ...string[]];
}

/** A finished command: how it ended and its combined output, which stops at the output limit. */
export interface CommandRun {
  readonly exit: CommandExit;
  readonly output: Uint8Array;
}

/** A workspace file could not be read. */
export class WorkspaceReadFailed extends Schema.TaggedError<WorkspaceReadFailed>()(
  "WorkspaceReadFailed",
  { path: Schema.String, detail: Schema.String },
) {}

/** A workspace file could not be written. */
export class WorkspaceWriteFailed extends Schema.TaggedError<WorkspaceWriteFailed>()(
  "WorkspaceWriteFailed",
  { path: Schema.String, detail: Schema.String },
) {}

export class GateExec extends Context.Service<
  GateExec,
  {
    /** A fresh, empty directory that no other job shares, removed when the scope closes (FD-GATE-030). */
    readonly workspace: Effect.Effect<string, never, Scope.Scope>;
    readonly run: (options: CommandOptions) => Effect.Effect<CommandRun>;
    readonly runArgv: (options: ArgvOptions) => Effect.Effect<CommandRun>;
    readonly readFile: (path: string) => Effect.Effect<Uint8Array, WorkspaceReadFailed>;
    /** Replaces an existing file's bytes and keeps its mode. */
    readonly writeFile: (
      path: string,
      bytes: Uint8Array,
    ) => Effect.Effect<void, WorkspaceWriteFailed>;
    /** Creates a file that does not exist yet, readable by every user and writable by none (mode 0444). */
    readonly createReadOnly: (
      path: string,
      bytes: Uint8Array,
    ) => Effect.Effect<void, WorkspaceWriteFailed>;
  }
>()("@fractalboxdev/flare-dispatch-catalog/GateExec") {}

const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group has already exited.
  }
};

const concat = (chunks: readonly Buffer[]): Uint8Array => new Uint8Array(Buffer.concat(chunks));

/** Runs `file` with `args` to its exit; interruption and a SIGTERM to the runner kill its process group. */
const supervise = (
  file: string,
  args: readonly string[],
  options: Omit<CommandOptions, "command">,
): Effect.Effect<CommandRun> =>
  Effect.callback<CommandRun>((resume) => {
    const limit = options.outputLimitBytes ?? OUTPUT_LIMIT_BYTES;
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    if (pid === undefined) {
      child.once("error", (e) =>
        resume(
          Effect.succeed({
            exit: CommandExit.NotStarted({ detail: e.message }),
            output: new Uint8Array(),
          }),
        ),
      );
      return;
    }
    let verdict: CommandExit | undefined;
    let written = 0;
    const chunks: Buffer[] = [];
    let escalate: NodeJS.Timeout | undefined;
    const stop = (because: CommandExit) => {
      verdict ??= because;
      signalGroup(pid, "SIGTERM");
      escalate ??= setTimeout(() => signalGroup(pid, "SIGKILL"), KILL_GRACE_MS);
    };
    const untilDeadline =
      options.deadlineAt === undefined ? Infinity : Math.max(0, options.deadlineAt - Date.now());
    const deadlineFirst = untilDeadline < options.timeoutMs;
    const timer = setTimeout(
      () => stop(deadlineFirst ? CommandExit.DeadlineReached() : CommandExit.TimedOut()),
      deadlineFirst ? untilDeadline : options.timeoutMs,
    );
    const count = (chunk: Buffer) => {
      if (verdict !== undefined && CommandExit.$is("OverLimit")(verdict)) return;
      written += chunk.length;
      if (written > limit) return stop(CommandExit.OverLimit());
      chunks.push(chunk);
      if (options.logAs === undefined) process.stderr.write(chunk);
    };
    child.stdout.on("data", count);
    child.stderr.on("data", count);
    const onRunnerStopped = () => {
      signalGroup(pid, "SIGKILL");
      process.exit(143);
    };
    process.once("SIGTERM", onRunnerStopped);
    const release = () => {
      clearTimeout(timer);
      clearTimeout(escalate);
      process.removeListener("SIGTERM", onRunnerStopped);
    };
    child.once("close", (code, signal) => {
      // A stopped command's group dies with it: a member that outlives the SIGTERM, by ignoring it or by not holding
      // the output open, takes the SIGKILL now rather than after the grace period the runner may not live through.
      if (verdict !== undefined) signalGroup(pid, "SIGKILL");
      release();
      if (options.logAs !== undefined) process.stderr.write(options.logAs(concat(chunks)));
      resume(
        Effect.succeed({
          exit:
            verdict ??
            (signal === null
              ? CommandExit.Exited({ code: code ?? 1 })
              : CommandExit.Signalled({ signal })),
          output: concat(chunks),
        }),
      );
    });
    return Effect.sync(() => {
      release();
      signalGroup(pid, "SIGKILL");
    });
  });

/** Runs one command through `/bin/sh -c` to its exit. */
export const runCommand = (options: CommandOptions): Effect.Effect<CommandRun> =>
  supervise("/bin/sh", ["-c", options.command], options);

/** Runs one argv with no shell to its exit; a binary that cannot start ends `NotStarted`. */
export const runArgv = (options: ArgvOptions): Effect.Effect<CommandRun> => {
  const [file, ...args] = options.argv;
  return supervise(file, args, options);
};

/**
 * A workspace sits outside the repository the runner starts from, so a dependency the commit lacks cannot resolve from
 * a parent `node_modules`. `FD_WORKSPACE_ROOT` names where it goes, the OS temporary directory by default.
 */
const workspace: Effect.Effect<string, never, Scope.Scope> = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(process.env["FD_WORKSPACE_ROOT"] ?? tmpdir(), "fd-job-"))),
  (dir) =>
    Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(
      Effect.catchDefect(() => Effect.void),
    ),
);

/** `GateExec` over this host's processes and file system. */
export const processGateExec: Layer.Layer<GateExec> = Layer.succeed(GateExec, {
  workspace,
  run: runCommand,
  runArgv,
  readFile: (path) =>
    Effect.tryPromise({
      try: async () => new Uint8Array(await readFile(path)),
      catch: (cause) => new WorkspaceReadFailed({ path, detail: String(cause) }),
    }),
  writeFile: (path, bytes) =>
    Effect.tryPromise({
      try: () => writeFile(path, bytes),
      catch: (cause) => new WorkspaceWriteFailed({ path, detail: String(cause) }),
    }),
  createReadOnly: (path, bytes) =>
    Effect.tryPromise({
      try: () => writeFile(path, bytes, { mode: 0o444, flag: "wx" }),
      catch: (cause) => new WorkspaceWriteFailed({ path, detail: String(cause) }),
    }),
});
