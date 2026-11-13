// The job sandbox's Layers for the recipe services: the shell, the checkout's files, the edit loop, the staged write,
// the artifact store, the intents and the model gateway, and the cloud executor's composition of them. They import Node
// APIs, so only the executor entry exports them.
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { Intents } from "@fractalboxdev/mameko-run";
import { Effect, Layer } from "effect";
import { pathInvalid } from "../staged-write/gate.ts";
import {
  buildStagedWrite,
  sha256Hex,
  uploadStagedWrite,
  type ArtifactSink,
} from "../staged-write/build.ts";
import { ExecutionsRead } from "./ci-triage-pr.ts";
import { executionsApiReadLayer } from "./executions-read.ts";
import { githubIssuesReadLayer, IssuesRead } from "./triage-issues.ts";
import { githubPullRequestsReadLayer, PullRequestsRead } from "./triage-prs.ts";
import {
  ArtifactFailed,
  Artifacts,
  Checkout,
  EditLoop,
  ExecutionIdentity,
  modelGatewayClientLayer,
  type EditLoopResult,
  ModelClient,
  RecipeIntents,
  Shell,
  StagedWrites,
  StageFailed,
  SuppressionLedger,
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
): Effect.Effect<CommandResult & { readonly started: boolean }> =>
  Effect.callback<CommandResult & { readonly started: boolean }>((resume) => {
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
      resume(Effect.succeed({ started: false, exitCode: null, stdout, stderr: e.message }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // A null code here means a signal ended a process that started, such as the timeout's SIGKILL.
      resume(Effect.succeed({ started: true, exitCode: code, stdout, stderr }));
    });
    // A started command can close stdin before consuming the prompt (or exit while it is being written).
    // Its close/exit status still owns the result; a late pipe error must not escape into the executor process.
    child.stdin.on("error", () => {});
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
    return Effect.sync(() => {
      clearTimeout(timer);
      child.kill("SIGKILL");
    });
  });

/** The variables a sandboxed process inherits from the runner; every other variable stays with the runner. */
const SANDBOX_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "TZ",
  "USER",
] as const;

/**
 * The environment of a command the run starts in the job sandbox: the allowlisted variables of `base` plus `extra`.
 * The runner's own variables, a per-lease credential among them, never reach the command (FD-AGT-010).
 */
export const sandboxEnv = (
  base: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SANDBOX_ENV_KEYS) if (base[key] !== undefined) env[key] = base[key];
  return { ...env, ...extra };
};

/**
 * `Shell` in the checkout through `sh -c`, 10 min per command unless the call names another timeout. A command
 * inherits the runner's environment unless `env` is given.
 */
export const shellLayer = (checkout: string, env?: NodeJS.ProcessEnv): Layer.Layer<Shell> =>
  Layer.succeed(Shell, {
    run: (command, options) =>
      Effect.map(
        runProcess("sh", ["-c", command], {
          cwd: options?.cwd ?? checkout,
          timeoutMs: options?.timeoutMs ?? 600_000,
          ...(env === undefined ? {} : { env }),
        }),
        ({ exitCode, stdout, stderr }): CommandResult => ({ exitCode, stdout, stderr }),
      ),
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
 * its proxy, not this Layer, decide what the command can reach (FD-AGT-010). The command inherits the runner's
 * environment unless `env` is given.
 */
export const editLoopLayer = (
  checkout: string,
  command: readonly [string, ...string[]],
  timeoutMs = 1_800_000,
  env?: NodeJS.ProcessEnv,
) =>
  Layer.succeed(EditLoop, {
    run: (prompt) =>
      Effect.map(
        runProcess(command[0], command.slice(1), {
          cwd: checkout,
          timeoutMs,
          stdin: prompt,
          ...(env === undefined ? {} : { env }),
        }),
        (r): EditLoopResult => ({ started: r.started, exitCode: r.exitCode }),
      ),
  });

/**
 * `StagedWrites` over `buildStagedWrite` against the base commit, written under the staging directory, then uploaded
 * to the execution's artifact store, so the manifest a run returns names only blobs the control plane can read back
 * (FD-AGT-013).
 */
export const stagedWritesLayer = (
  checkout: string,
  baseCommit: string,
  stagingDir: string,
  artifacts: ArtifactSink,
): Layer.Layer<StagedWrites> =>
  Layer.succeed(StagedWrites, {
    stage: (input) =>
      Effect.gen(function* () {
        const { manifest } = yield* buildStagedWrite({
          checkout,
          baseCommit,
          stagingDir,
          ...input,
        });
        yield* uploadStagedWrite(stagingDir, manifest, artifacts);
        return manifest;
      }).pipe(Effect.mapError((e) => new StageFailed({ detail: `${e.step}: ${e.detail}` }))),
  });

/** An artifact name the artifact store accepts (FD-CACHE-070): the name grammar, with no `.`, `..` or empty segment. */
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const validArtifactName = (name: string) =>
  ARTIFACT_NAME.test(name) && !name.split("/").some((s) => s === ".." || s === "." || s === "");

/**
 * `Artifacts` over the execution's artifact store: each `dashboard` artifact goes byte for byte, with its SHA-256
 * digest, under the lease's artifact prefix through `sink`, and `put` answers nothing a run could publish. The store's
 * only reader is the dashboard's authenticated artifact route (FD-AGT-059).
 */
export const artifactsLayer = (sink: ArtifactSink): Layer.Layer<Artifacts> =>
  Layer.succeed(Artifacts, {
    put: (name, bytes, _access) =>
      validArtifactName(name)
        ? Effect.tryPromise({
            try: () => sink.put(name, bytes, sha256Hex(bytes)),
            catch: (cause) => new ArtifactFailed({ detail: `${name}: ${String(cause)}` }),
          })
        : Effect.fail(new ArtifactFailed({ detail: `${name} is not an artifact name` })),
  });

const refused = (step: string, kind: string, detail: string) =>
  Effect.logWarning("intent refused; the runner fails the run", { step, kind, detail });

/**
 * `RecipeIntents` over the runner's `Intents`, each keyed `run:<step>:<index>`. An emission mameko refuses
 * (`DuplicateIntentKey`, `IntentLimitExceeded`) fails the whole run in the runner with `infra: <tag>` and sends none of
 * its intents (MAMEKO-RUN-070, MAMEKO-RUN-071), so here it is logged.
 */
export const runnerIntentsLayer: Layer.Layer<RecipeIntents, never, Intents> = Layer.effect(
  RecipeIntents,
  Effect.gen(function* () {
    const intents = yield* Intents;
    return {
      append: (step, kind, payload) =>
        intents.emit(`run:${step}`, { kind, payload }).pipe(
          Effect.catchTags({
            DuplicateIntentKey: (e) => refused(step, kind, `duplicate key ${e.intentKey}`),
            IntentLimitExceeded: (e) => refused(step, kind, `limit ${e.limit}`),
          }),
        ),
    };
  }),
);

/** What the cloud executor knows of one execution's job sandbox. */
export interface CloudAgenticConfig {
  /** The execution the job sandbox serves, as the lease names it. */
  readonly executionId: string;
  /** The checkout the workspace holds, at `baseCommit`. */
  readonly checkout: string;
  readonly baseCommit: string;
  /** The staged write's directory, outside the checkout's tracked files. */
  readonly stagingDir: string;
  /** The coding-agent command of the edit loop. */
  readonly editLoop: readonly [string, ...string[]];
  /** The edit loop's timeout; 30 min when absent. */
  readonly editLoopTimeoutMs?: number;
  /** The model route's URL; the egress proxy attaches the per-lease token to a request to it (FD-AGT-010). */
  readonly modelGatewayUrl: string;
  /** The control plane's origin, whose executions and log routes `ExecutionsRead` reads through the egress proxy. */
  readonly controlPlaneUrl: string;
  /** The job's `fetch`, whose requests leave through the egress proxy. */
  readonly fetch: typeof globalThis.fetch;
  /** The execution's artifact store under the lease's artifact prefix. */
  readonly artifacts: ArtifactSink;
  /** The runner's environment; a sandboxed command inherits only its allowlisted variables. */
  readonly env: NodeJS.ProcessEnv;
  /** Credentials the runner holds, such as a clone token; a model request carrying one is refused (FD-AGT-011). */
  readonly credentials: readonly string[];
  /** The suppression ledger's read; the job holds no binding of the control plane's database (FD-AGT-043). */
  readonly suppressionLedger: Layer.Layer<SuppressionLedger>;
}

export type CloudAgenticServices =
  | ModelClient
  | Shell
  | Checkout
  | EditLoop
  | StagedWrites
  | Artifacts
  | RecipeIntents
  | ExecutionsRead
  | IssuesRead
  | PullRequestsRead
  | SuppressionLedger
  | ExecutionIdentity;

/**
 * The agentic recipes' services on the cloud executor. The model client sends no credential and reaches the model
 * route through the egress proxy, which alone holds the per-lease token; the shell and the edit loop start with the
 * sandbox environment, so no runner variable reaches them (FD-AGT-010). Artifacts go to the execution's artifact store
 * (FD-AGT-059). `ExecutionsRead` reads the control plane's executions and log routes, so the job holds no binding of the
 * executions table or the log store (FD-AGT-071). `IssuesRead` reads GitHub's issue list and `PullRequestsRead` its
 * open pull requests through the egress proxy. The suppression ledger is the read the runner entry supplies.
 * `ExecutionIdentity` names the execution the lease serves.
 */
export const cloudAgenticLayers = (
  config: CloudAgenticConfig,
): Layer.Layer<CloudAgenticServices, never, Intents> => {
  const env = sandboxEnv(config.env, { FD_MODEL_GATEWAY_URL: config.modelGatewayUrl });
  return Layer.mergeAll(
    modelGatewayClientLayer({
      url: config.modelGatewayUrl,
      fetch: config.fetch,
      forbidden: config.credentials,
    }),
    shellLayer(config.checkout, env),
    checkoutLayer(config.checkout),
    editLoopLayer(config.checkout, config.editLoop, config.editLoopTimeoutMs, env),
    stagedWritesLayer(config.checkout, config.baseCommit, config.stagingDir, config.artifacts),
    artifactsLayer(config.artifacts),
    runnerIntentsLayer,
    executionsApiReadLayer({ baseUrl: config.controlPlaneUrl, fetch: config.fetch }),
    githubIssuesReadLayer({
      apiBase: "https://api.github.com",
      fetch: config.fetch,
    }),
    githubPullRequestsReadLayer({
      apiBase: "https://api.github.com",
      fetch: config.fetch,
    }),
    config.suppressionLedger,
    Layer.succeed(ExecutionIdentity, { executionId: config.executionId }),
  );
};
