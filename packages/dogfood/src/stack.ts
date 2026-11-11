// The device path of the end-to-end stack on one machine (specs/verification.md § V-E2E-LOCAL): the control plane
// under `wrangler dev` for the development deployment, mameko's key helper and device executor from the pinned
// `vendor/mameko`, and the device's runner child executing the catalogue's runs on the host. `pnpm dogfood` and the
// device-path suites of `apps/control-plane/test/e2e-local/device/` start the same stack.
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { Effect, Schedule, Schema } from "effect";
import { placeholderOverlay } from "@fractalboxdev/flare-dispatch-ops/overlay";
import { renderTemplate } from "@fractalboxdev/flare-dispatch-ops/render";
import { DOGFOOD_IDENTITY, startAccessTeam, type LocalAccessTeam } from "./access.ts";
import { DeviceIdentity, health, makeClient, type ControlPlaneClient } from "./client.ts";
import { capture, CommandFailed, startService, type RunOptions } from "./processes.ts";

const START_WAIT_MS = 60_000;

/** The environment of every process here, without any credential the operator's shell holds. */
export const localEnv = (extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv => ({
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

export interface Binaries {
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

/** Builds the key helper, the device executor and the CLI from the pinned `vendor/mameko`. */
export const buildDevicePrograms = (repoRoot: string) =>
  Effect.gen(function* () {
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

/**
 * The repository the development deployment reads in place of GitHub (`FD_DEV_REPOSITORY`): its default branch's
 * head and the base64 text of each file at that commit, or null where the commit has none.
 */
export interface DevRepository {
  readonly repository: string;
  readonly installation: number;
  readonly default_branch: string;
  readonly head: string;
  readonly files: Readonly<Record<string, string | null>>;
  readonly confidentiality: "confidential" | "non-confidential";
}

/** A dotenv value wrangler reads literally: single-quoted, so JSON keeps its double quotes. */
const literal = (value: unknown) => `'${JSON.stringify(value)}'`;

/**
 * The control plane's template rendered with the placeholder overlay, beside the template so the paths inside it
 * resolve, and removed when the scope closes. `wrangler dev` refuses the template's unrendered placeholders; the
 * local values that matter (the deployment, the Access team, the repository) come from the vars file.
 */
const renderedConfig = (appDir: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const template = readFileSync(join(appDir, "wrangler.jsonc"), "utf8");
      const rendered = yield* renderTemplate("control-plane", template, placeholderOverlay).pipe(
        Effect.mapError(
          (e) =>
            new CommandFailed({
              command: "render wrangler.jsonc",
              detail: `no overlay value for ${e.paths.join(", ")}`,
            }),
        ),
      );
      const path = join(appDir, `.dogfood-${process.pid}-${Date.now()}.wrangler.jsonc`);
      writeFileSync(path, rendered);
      return path;
    }),
    (path) => Effect.sync(() => rmSync(path, { force: true })),
  );

/** The control plane under `wrangler dev` for the development deployment, its state under `runtimeDir`. */
export const startControlPlane = (input: {
  readonly repoRoot: string;
  readonly runtimeDir: string;
  readonly team: LocalAccessTeam;
  readonly devRepository: DevRepository;
}) =>
  Effect.gen(function* () {
    const { repoRoot, runtimeDir, team, devRepository } = input;
    const port = yield* freePort;
    const varsPath = join(runtimeDir, "dev.vars");
    const vars = {
      DEPLOYMENT: "development",
      ACCESS_TEAM_DOMAIN: team.teamDomain,
      ACCESS_AUD: team.aud,
      OPERATORS: literal([DOGFOOD_IDENTITY]),
      DISPATCHERS: literal([DOGFOOD_IDENTITY]),
      FD_DEV_REPOSITORY: literal(devRepository),
      // The template's overlay placeholders that a local run has no value for: no alert sink and no GitHub App.
      ALERT_SINK: "",
      GITHUB_APP_ID: "",
      GITHUB_FIXTURE_REPO: "",
    };
    writeFileSync(
      varsPath,
      Object.entries(vars)
        .map(([name, value]) => `${name}=${value}\n`)
        .join(""),
    );
    chmodSync(varsPath, 0o600);
    const appDir = join(repoRoot, "apps/control-plane");
    const config = yield* renderedConfig(appDir);
    yield* startService(
      join(appDir, "node_modules/.bin/wrangler"),
      [
        "dev",
        "--config",
        config,
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
        detail: `the control plane reports deployment ${ready.deployment}`,
      });
    return { origin, planeId: ready.plane_id };
  });

const deviceIdentity = (cli: string, options: RunOptions) =>
  capture(cli, ["identity", "--helper", "helper.sock"], options).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(DeviceIdentity))),
    Effect.retry({ schedule: Schedule.spaced(100), times: 100 }),
  );

/**
 * The key helper and the device executor, enrolled as `executorId`. The device runs each job under mameko's
 * host-process runtime, in a workspace under `workspaceRoot`; `env` adds to its environment.
 */
export const startDevice = (input: {
  readonly repoRoot: string;
  readonly binaries: Binaries;
  readonly client: ControlPlaneClient;
  readonly origin: string;
  readonly planeId: string;
  readonly runtimeDir: string;
  readonly workspaceRoot: string;
  readonly executorId: string;
  readonly env?: Readonly<Record<string, string>>;
}) =>
  Effect.gen(function* () {
    const { binaries, client, origin, planeId, runtimeDir, workspaceRoot, executorId } = input;
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
    yield* client.register({ executorId, identity });
    const catalog = join(input.repoRoot, "packages/catalog/src");
    const strip = ["--experimental-strip-types", "--no-warnings"];
    yield* startService(
      binaries.deviceExecutor,
      [
        "--job-runtime",
        "host-process",
        "--allow-host-process",
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
        env: localEnv({
          ...input.env,
          FD_DEPLOYMENT: "development",
          FD_WORKSPACE_ROOT: workspaceRoot,
        }),
      },
    );
    return identity;
  });

export interface DeviceStack {
  readonly origin: string;
  readonly planeId: string;
  readonly client: ControlPlaneClient;
}

/**
 * The whole device-path stack for one scope: the device programs built, the local Access team, the control plane
 * reading `devRepository`, and one enrolled device. Closing the scope stops every process it started.
 */
export const startDeviceStack = (input: {
  readonly repoRoot: string;
  readonly runtimeDir: string;
  readonly workspaceRoot: string;
  readonly devRepository: DevRepository;
  readonly executorId: string;
  readonly deviceEnv?: Readonly<Record<string, string>>;
}) =>
  Effect.gen(function* () {
    const binaries = yield* buildDevicePrograms(input.repoRoot);
    const team = yield* startAccessTeam;
    const { origin, planeId } = yield* startControlPlane({ ...input, team });
    const client = makeClient(origin, team.jwt);
    yield* startDevice({
      ...input,
      binaries,
      client,
      origin,
      planeId,
      ...(input.deviceEnv === undefined ? {} : { env: input.deviceEnv }),
    });
    return { origin, planeId, client } satisfies DeviceStack;
  });
