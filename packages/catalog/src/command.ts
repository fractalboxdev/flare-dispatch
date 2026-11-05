// One supervised child process. The child leads its own process group, so a timeout or a stopped runner kills
// everything the command started. Its output reaches the runner's stderr: the runner's stdout carries only the result
// line, and any other line there loses the result (MAMEKO-EXEC-122).
import { spawn } from "node:child_process";
import { Data, Effect } from "effect";

/** The most combined stdout and stderr one command may write (FD-GATE-008). */
export const OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;

/** How long a command has to exit after SIGTERM, before SIGKILL. */
const KILL_GRACE_MS = 5_000;

export type CommandExit = Data.TaggedEnum<{
  Exited: { readonly code: number };
  Signalled: { readonly signal: string };
  TimedOut: {};
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
  readonly outputLimitBytes?: number;
}

const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group has already exited.
  }
};

/** Runs one command to its exit; interruption and a SIGTERM to the runner kill its process group. */
export const runCommand = (options: CommandOptions): Effect.Effect<CommandExit> =>
  Effect.callback<CommandExit>((resume) => {
    const limit = options.outputLimitBytes ?? OUTPUT_LIMIT_BYTES;
    const child = spawn("/bin/sh", ["-c", options.command], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    if (pid === undefined) {
      child.once("error", (e) =>
        resume(Effect.succeed(CommandExit.NotStarted({ detail: e.message }))),
      );
      return;
    }
    let verdict: CommandExit | undefined;
    let written = 0;
    let escalate: NodeJS.Timeout | undefined;
    const stop = (because: CommandExit) => {
      verdict ??= because;
      signalGroup(pid, "SIGTERM");
      escalate ??= setTimeout(() => signalGroup(pid, "SIGKILL"), KILL_GRACE_MS);
    };
    const timeout = setTimeout(() => stop(CommandExit.TimedOut()), options.timeoutMs);
    const count = (chunk: Buffer) => {
      written += chunk.length;
      if (written > limit) return stop(CommandExit.OverLimit());
      process.stderr.write(chunk);
    };
    child.stdout.on("data", count);
    child.stderr.on("data", count);
    const onRunnerStopped = () => {
      signalGroup(pid, "SIGKILL");
      process.exit(143);
    };
    process.once("SIGTERM", onRunnerStopped);
    const release = () => {
      clearTimeout(timeout);
      clearTimeout(escalate);
      process.removeListener("SIGTERM", onRunnerStopped);
    };
    child.once("close", (code, signal) => {
      release();
      resume(
        Effect.succeed(
          verdict ??
            (signal === null
              ? CommandExit.Exited({ code: code ?? 1 })
              : CommandExit.Signalled({ signal })),
        ),
      );
    });
    return Effect.sync(() => {
      release();
      signalGroup(pid, "SIGKILL");
    });
  });
