// The child processes of one dogfood run. Each service leads its own process group, and its scope's finalizer stops the
// whole group, so no exit path leaves a process behind.
import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { Console, Effect, Schema, type Scope } from "effect";

export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  command: Schema.String,
  detail: Schema.String,
}) {}

const MAX_CAPTURED_BYTES = 256 * 1024 * 1024;

export interface RunOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

/** Runs a command to its end and answers its stdout. */
export const capture = (
  program: string,
  args: readonly string[],
  options: RunOptions,
): Effect.Effect<string, CommandFailed> =>
  Effect.callback((resume) => {
    execFile(
      program,
      args,
      { ...options, encoding: "utf8", maxBuffer: MAX_CAPTURED_BYTES },
      (error, stdout, stderr) =>
        resume(
          error === null
            ? Effect.succeed(stdout)
            : Effect.fail(
                new CommandFailed({
                  command: `${program} ${args.join(" ")}`,
                  detail: `${error.message}\n${stderr}`,
                }),
              ),
        ),
    );
  });

/** The live members of a process group. */
const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group has already exited.
  }
};

const STOP_GRACE_MS = 5_000;
const STOP_POLL_MS = 50;

/** SIGTERM to the group, then SIGKILL to whatever remains after the grace period; ends once the group is gone. */
const stopGroup = (name: string, pid: number) =>
  Effect.gen(function* () {
    signalGroup(pid, "SIGTERM");
    const until = Date.now() + STOP_GRACE_MS;
    while (groupAlive(pid) && Date.now() < until) yield* Effect.sleep(STOP_POLL_MS);
    if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
    while (groupAlive(pid)) yield* Effect.sleep(STOP_POLL_MS);
    yield* Console.log(`stopped ${name}`);
  });

export interface ServiceOptions extends RunOptions {
  readonly name: string;
  readonly logPath: string;
}

/** Starts a long-running process in its own group, its output in `logPath`, stopped when the scope closes. */
export const startService = (
  program: string,
  args: readonly string[],
  options: ServiceOptions,
): Effect.Effect<void, CommandFailed, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<number, CommandFailed>((resume) => {
      const log = openSync(options.logPath, "a");
      const child = spawn(program, args, {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ["ignore", log, log],
      });
      child.once("spawn", () => {
        closeSync(log);
        resume(Effect.succeed(child.pid ?? 0));
      });
      child.once("error", (error) => {
        closeSync(log);
        resume(Effect.fail(new CommandFailed({ command: options.name, detail: error.message })));
      });
    }),
    (pid) => stopGroup(options.name, pid),
  ).pipe(Effect.asVoid);
