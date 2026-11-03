// The job sandbox's Layers for the recipe services that touch the checkout: the shell, the checkout's files, the edit
// loop and the staged write. They import Node APIs, so only the executor entry exports them.
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { Effect, Layer } from "effect";
import { pathInvalid } from "../staged-write/gate.ts";
import { buildStagedWrite } from "../staged-write/build.ts";
import {
  Checkout,
  EditLoop,
  Shell,
  StagedWrites,
  StageFailed,
  type CommandResult,
} from "./services.ts";

const OUTPUT_CAP = 8 * 1024 * 1024;

const runProcess = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly stdin?: string;
    readonly env?: NodeJS.ProcessEnv;
  },
): Effect.Effect<CommandResult> =>
  Effect.callback<CommandResult>((resume) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env ?? process.env });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += c.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resume(Effect.succeed({ exitCode: null, stdout, stderr: e.message }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resume(Effect.succeed({ exitCode: code, stdout, stderr }));
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
    return Effect.sync(() => {
      clearTimeout(timer);
      child.kill("SIGKILL");
    });
  });

/** `Shell` in the checkout through `sh -c`, 10 min per command unless the call names another timeout. */
export const shellLayer = (checkout: string): Layer.Layer<Shell> =>
  Layer.succeed(Shell, {
    run: (command, options) =>
      runProcess("sh", ["-c", command], {
        cwd: options?.cwd ?? checkout,
        timeoutMs: options?.timeoutMs ?? 600_000,
      }),
  });

const walk = async (root: string, dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(root, path)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
};

/** `Checkout` over the checkout directory; a write to a malformed path or outside the checkout is refused. */
export const checkoutLayer = (checkout: string): Layer.Layer<Checkout> =>
  Layer.succeed(Checkout, {
    read: (path) => Effect.promise(() => readFile(join(checkout, path), "utf8").catch(() => null)),
    list: (dir) => Effect.promise(async () => (await walk(checkout, dir)).sort()),
    write: (path, text) =>
      pathInvalid(path) || relative(checkout, join(checkout, path)).startsWith("..")
        ? Effect.fail(new StageFailed({ detail: `path ${path} is not a checkout path` }))
        : Effect.tryPromise({
            try: async () => {
              await mkdir(dirname(join(checkout, path)), { recursive: true });
              await writeFile(join(checkout, path), text);
            },
            catch: (cause) => new StageFailed({ detail: String(cause) }),
          }),
  });

/**
 * `EditLoop` as the configured coding-agent command, with the prompt on its stdin. The sandbox's egress profile and
 * its proxy, not this Layer, decide what the command can reach (FD-AGT-010).
 */
export const editLoopLayer = (
  checkout: string,
  command: readonly [string, ...string[]],
  timeoutMs = 1_800_000,
) =>
  Layer.succeed(EditLoop, {
    run: (prompt) =>
      Effect.map(
        runProcess(command[0], command.slice(1), { cwd: checkout, timeoutMs, stdin: prompt }),
        (r) => ({
          exitCode: r.exitCode,
        }),
      ),
  });

/** `StagedWrites` over `buildStagedWrite` against the base commit, written under the staging directory. */
export const stagedWritesLayer = (
  checkout: string,
  baseCommit: string,
  stagingDir: string,
): Layer.Layer<StagedWrites> =>
  Layer.succeed(StagedWrites, {
    stage: (input) =>
      buildStagedWrite({ checkout, baseCommit, stagingDir, ...input }).pipe(
        Effect.map((w) => w.manifest),
        Effect.mapError((e) => new StageFailed({ detail: `${e.step}: ${e.detail}` })),
      ),
  });
