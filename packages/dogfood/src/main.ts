// `pnpm dogfood [<git ref>]`: runs FlareDispatch's CI on this machine through a real execution. A control plane under
// `wrangler dev`, the key helper and the device executor start here; the device takes the lease, its runner child runs
// the `check` run, and the verdict printed is the control plane's execution record.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import type { CheckInput } from "@fractalboxdev/flare-dispatch-catalog";
import { Console, Effect, Runtime, Schedule, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import { DeviceIdentity, health, makeClient, type ControlPlaneClient } from "./client.ts";
import { capture, CommandFailed, startService, type RunOptions } from "./processes.ts";
import { EXIT_NO_VERDICT, exitCodeOf, verdictLines } from "./verdict.ts";

const ISOLATION_NOTICE =
  "isolation: MAMEKO-ISO-001 forbids job code on the device OS and no conformant macOS runtime exists, so this run executes on the host. It is reachable only under the development deployment; production refuses it.";

const REPOSITORY = "fractalboxdev/flare-dispatch";

/** The commands of the repository's CI, which the dispatch carries (FD-GATE-001). */
const CI_STEPS: CheckInput["steps"] = [
  { label: "install", command: "pnpm install --frozen-lockfile", timeoutSec: 900 },
  { label: "lint", command: "pnpm lint", timeoutSec: 600 },
  { label: "typecheck", command: "pnpm typecheck", timeoutSec: 900 },
  { label: "test", command: "pnpm test", timeoutSec: 1800 },
];

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** How long the device has to take a lease before the command stops waiting. */
const LEASE_WAIT_MS = 120_000;
const START_WAIT_MS = 60_000;
const WAIT_SEC = 5;
const LOG_TAIL_LINES = 40;

/** The command's failure: a process exit code and no second report, since the program printed its own. */
class DogfoodExit extends Schema.TaggedError<DogfoodExit>()("DogfoodExit", {
  code: Schema.Number,
}) {
  get [Runtime.errorExitCode]() {
    return this.code;
  }
  get [Runtime.errorReported]() {
    return false;
  }
}

/** The environment of every process here, without any credential the operator's shell holds. */
const localEnv = (extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(CLOUDFLARE|CF|GITHUB|GH|AWS|ANTHROPIC|OPENAI)_/.test(name),
    ),
  ),
  ...extra,
});

const freePort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    server.close(() => resume(Effect.succeed(port)));
  });
});

interface Binaries {
  readonly keyHelper: string;
  readonly deviceExecutor: string;
  readonly cli: string;
}

const CargoArtifact = Schema.Struct({
  target: Schema.Struct({ name: Schema.String }),
  executable: Schema.String,
});

/** The executables a build wrote, by target name. The paths come from cargo, whose build directory may be pooled. */
export const parseArtifacts = (messages: string): ReadonlyMap<string, string> =>
  new Map(
    messages
      .split("\n")
      .filter((line) => line.includes('"executable":"'))
      .map((line) => Schema.decodeSync(Schema.fromJsonString(CargoArtifact))(line))
      .map((artifact) => [artifact.target.name, artifact.executable] as const),
  );

const buildDevicePrograms = Effect.gen(function* () {
  yield* Console.log("building the device programs");
  const messages = yield* capture(
    "cargo",
    [
      "build",
      "--message-format=json",
      "-p",
      "mameko-device-executor",
      "-p",
      "mameko-key-helper",
      "-p",
      "mameko-cli",
    ],
    {
      cwd: join(repoRoot, "vendor/mameko"),
      env: { CARGO_TARGET_DIR: join(repoRoot, ".tmp/target"), ...process.env },
    },
  );
  const built = parseArtifacts(messages);
  const binary = (name: string) => built.get(name) ?? name;
  return {
    keyHelper: binary("mameko-key-helper"),
    deviceExecutor: binary("mameko-device-executor"),
    cli: binary("mameko-cli"),
  } satisfies Binaries;
});

/** `file://` serves a commit no remote has, and a shallow fetch of it. */
const resolveCommit = (ref: string) =>
  capture("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: repoRoot,
    env: process.env,
  }).pipe(Effect.map((sha) => sha.trim()));

const startControlPlane = (runtimeDir: string, operatorToken: string) =>
  Effect.gen(function* () {
    const port = yield* freePort;
    const varsPath = join(runtimeDir, "dev.vars");
    writeFileSync(varsPath, `DEPLOYMENT=development\nOPERATOR_TOKEN=${operatorToken}\n`);
    chmodSync(varsPath, 0o600);
    const appDir = join(repoRoot, "apps/control-plane");
    yield* startService(
      join(appDir, "node_modules/.bin/wrangler"),
      [
        "dev",
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--persist-to",
        join(runtimeDir, "state"),
        "--env-file",
        varsPath,
        "--show-interactive-dev-session=false",
      ],
      {
        name: "control plane (wrangler dev)",
        logPath: join(runtimeDir, "control-plane.log"),
        cwd: appDir,
        env: localEnv({ WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: runtimeDir }),
      },
    );
    const origin = `http://127.0.0.1:${port}`;
    const ready = yield* health(origin).pipe(
      Effect.retry(
        Schedule.spaced(250).pipe(Schedule.while(({ elapsed }) => elapsed < START_WAIT_MS)),
      ),
    );
    if (ready.deployment !== "development")
      return yield* new CommandFailed({
        command: "wrangler dev",
        detail: `the control plane reports deployment `,
      });
    return { origin, planeId: ready.plane_id };
  });

const deviceIdentity = (cli: string, options: RunOptions) =>
  capture(cli, ["identity", "--helper", "helper.sock"], options).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(DeviceIdentity))),
    Effect.retry({ schedule: Schedule.spaced(100), times: 100 }),
  );

const startDevice = (input: {
  readonly binaries: Binaries;
  readonly client: ControlPlaneClient;
  readonly origin: string;
  readonly planeId: string;
  readonly runtimeDir: string;
  readonly workspaceRoot: string;
}) =>
  Effect.gen(function* () {
    const { binaries, client, origin, planeId, runtimeDir, workspaceRoot } = input;
    // Relative paths keep each socket inside the platform's 104-byte `sun_path`, whatever the checkout's path is.
    const options = { cwd: runtimeDir, env: localEnv({}) };
    yield* startService(
      binaries.keyHelper,
      [
        "--key",
        "device.key",
        "--socket",
        "helper.sock",
        "--allow-software-key",
        "--purpose",
        "connect",
      ],
      { ...options, name: "key helper", logPath: join(runtimeDir, "key-helper.log") },
    );
    const identity = yield* deviceIdentity(binaries.cli, options);
    const executorId = `dogfood-${hostname().split(".")[0]}`;
    yield* client.register({ executorId, identity });
    yield* Console.log(`enrolled ${executorId} with a ${identity.key_store} key`);
    const catalog = join(repoRoot, "packages/catalog/src");
    const strip = ["--experimental-strip-types", "--no-warnings"];
    yield* startService(
      binaries.deviceExecutor,
      [
        "--url",
        `${origin.replace("http://", "ws://")}/v1/executors/connect`,
        "--plane-id",
        planeId,
        "--executor-id",
        executorId,
        "--helper",
        "helper.sock",
        "--node",
        process.execPath,
        "--runner-main",
        join(catalog, "runner-entry.ts"),
        "--work-dir",
        "work",
        "--extension",
        process.execPath,
        ...[...strip, join(catalog, "device-extension.ts"), planeId].flatMap((arg) => [
          "--extension-arg",
          arg,
        ]),
        "--free",
        JSON.stringify({ batch: 1 }),
      ],
      {
        name: "device executor",
        logPath: join(runtimeDir, "device.log"),
        cwd: runtimeDir,
        env: localEnv({ FD_DEPLOYMENT: "development", FD_WORKSPACE_ROOT: workspaceRoot }),
      },
    );
  });

/** Follows the coordinator's record until it is `done`. */
const awaitVerdict = (client: ControlPlaneClient, executionId: string) =>
  Effect.gen(function* () {
    const started = Date.now();
    let last = "";
    while (true) {
      const view = yield* client.execution(executionId, WAIT_SEC);
      if (view.status !== last) {
        last = view.status;
        yield* Console.log(`execution ${executionId}: ${view.status}`);
      }
      if (view.status === "done") return view;
      if (view.status === "queued" && Date.now() - started > LEASE_WAIT_MS) {
        yield* Console.error(`no device took the lease within ${LEASE_WAIT_MS / 1000} s`);
        return yield* new DogfoodExit({ code: EXIT_NO_VERDICT });
      }
    }
  });

const logTail = (path: string) =>
  readFileSync(path, "utf8").split("\n").slice(-LOG_TAIL_LINES).join("\n");

const dogfood = (ref: string) =>
  Effect.gen(function* () {
    yield* Console.log(ISOLATION_NOTICE);
    const sha = yield* resolveCommit(ref);
    yield* Console.log(`commit: ${sha} (${ref})`);
    const binaries = yield* buildDevicePrograms;
    const runtimeDir = resolve(repoRoot, ".tmp/dogfood", String(Date.now()));
    mkdirSync(runtimeDir, { recursive: true });
    const workspaceRoot = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "fd-dogfood-"))),
      (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    );
    const operatorToken = randomBytes(32).toString("hex");
    const { origin, planeId } = yield* startControlPlane(runtimeDir, operatorToken);
    yield* Console.log(`control plane: ${origin}, plane ${planeId}, deployment development`);
    const client = makeClient(origin, operatorToken);
    yield* startDevice({ binaries, client, origin, planeId, runtimeDir, workspaceRoot });
    const { execution_id: executionId, class: className } = yield* client.dispatchCheck({
      repository: REPOSITORY,
      inputs: {
        repo: `file://${repoRoot.replace(/\/$/, "")}`,
        sha,
        ref,
        steps: CI_STEPS,
      },
    });
    yield* Console.log(`submitted check ${executionId}, class ${className}`);
    const view = yield* awaitVerdict(client, executionId);
    for (const line of verdictLines(view)) yield* Console.log(line);
    const code = exitCodeOf(view.verdict);
    if (code !== 0) {
      yield* Console.log(`device log tail:\n${logTail(join(runtimeDir, "device.log"))}`);
      return yield* new DogfoodExit({ code });
    }
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      CommandFailed: (e) => reportAndExit(`${e.command}: ${e.detail}`),
      ControlPlaneError: (e) => reportAndExit(`${e.route}: ${e.detail}`),
      SchemaError: (e) => reportAndExit(e.message),
    }),
  );

const reportAndExit = (message: string) =>
  Console.error(`dogfood stopped: ${message}`).pipe(
    Effect.andThen(Effect.fail(new DogfoodExit({ code: EXIT_NO_VERDICT }))),
  );

const command = Command.make(
  "dogfood",
  { ref: Argument.String("ref").pipe(Argument.withDefault("HEAD")) },
  ({ ref }) => dogfood(ref),
);

if (process.argv[1] === fileURLToPath(import.meta.url))
  Command.run(command, { version: "0.0.1" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
