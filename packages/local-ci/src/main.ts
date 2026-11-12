// `pnpm ci:local [<git ref>]`: runs FlareDispatch's CI on this machine through a real execution. A control plane under
// `wrangler dev`, the key helper and the device executor start here; the device takes the lease, its runner child runs
// the `check` run, and the verdict printed is the control plane's execution record.
import { mkdirSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import type { CheckInput } from "@fractalboxdev/flare-dispatch-catalog";
import { Console, Effect, Runtime, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import { startAccessTeam } from "./access.ts";
import { makeClient, type ControlPlaneClient } from "./client.ts";
import { capture } from "./processes.ts";
import {
  buildDevicePrograms,
  startControlPlane,
  startDevice,
  type DevRepository,
} from "./stack.ts";
import { EXIT_NO_VERDICT, exitCodeOf, verdictLines } from "./verdict.ts";

const ISOLATION_NOTICE =
  "isolation: the device executor runs this check under mameko's host-process development runtime, on the device OS with no job sandbox (isolation:none). Only the development deployment admits it; a production profile rejects a class with isolation none.";

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
/** How often the command reads the execution record. */
const POLL_MS = 2_000;
const LOG_TAIL_LINES = 40;

/** The command's failure: a process exit code and no second report, since the program printed its own. */
class LocalCiExit extends Schema.TaggedError<LocalCiExit>()("LocalCiExit", {
  code: Schema.Number,
}) {
  get [Runtime.errorExitCode]() {
    return this.code;
  }
  get [Runtime.errorReported]() {
    return false;
  }
}

/** `file://` serves a commit no remote has, and a shallow fetch of it. */
const resolveCommit = (ref: string) =>
  capture("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: repoRoot,
    env: process.env,
  }).pipe(Effect.map((sha) => sha.trim()));

/** The repository manifest's path (specs/intake.md § Repo manifest). */
const MANIFEST_PATH = ".github/flare-dispatch.json";

/**
 * The repository the development deployment reads in place of GitHub: this checkout, with the commit under test as
 * its default branch's head, and the manifest's text at that commit, or null where the commit has none.
 */
const devRepository = (sha: string) =>
  capture("git", ["show", `${sha}:${MANIFEST_PATH}`], { cwd: repoRoot, env: process.env }).pipe(
    Effect.map((text): string | null => Buffer.from(text).toString("base64")),
    Effect.catchTag("CommandFailed", () => Effect.succeed(null)),
    Effect.map((manifest): DevRepository => ({
      repository: REPOSITORY,
      installation: 1,
      default_branch: "main",
      head: sha,
      files: { [MANIFEST_PATH]: manifest },
      // The repository is public, so its runs may reach a host-process device (MAMEKO-LEASE-084).
      confidentiality: "non-confidential",
    })),
  );

/** Follows the coordinator's record until it is `done`. */
const awaitVerdict = (client: ControlPlaneClient, executionId: string) =>
  Effect.gen(function* () {
    const started = Date.now();
    let last = "";
    while (true) {
      const view = yield* client.execution(executionId);
      if (view.status !== last) {
        last = view.status;
        yield* Console.log(`execution ${executionId}: ${view.status}`);
      }
      if (view.status === "done") return view;
      if (view.status === "queued" && Date.now() - started > LEASE_WAIT_MS) {
        yield* Console.error(`no device took the lease within ${LEASE_WAIT_MS / 1000} s`);
        return yield* new LocalCiExit({ code: EXIT_NO_VERDICT });
      }
      yield* Effect.sleep(POLL_MS);
    }
  });

const logTail = (path: string) =>
  readFileSync(path, "utf8").split("\n").slice(-LOG_TAIL_LINES).join("\n");

const ciLocal = (ref: string) =>
  Effect.gen(function* () {
    yield* Console.log(ISOLATION_NOTICE);
    const sha = yield* resolveCommit(ref);
    yield* Console.log(`commit: ${sha} (${ref})`);
    yield* Console.log("building the device programs");
    const binaries = yield* buildDevicePrograms(repoRoot);
    const runtimeDir = resolve(repoRoot, ".tmp/local-ci", String(Date.now()));
    mkdirSync(runtimeDir, { recursive: true });
    const workspaceRoot = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "fd-local-ci-"))),
      (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    );
    const team = yield* startAccessTeam;
    const { origin, planeId } = yield* startControlPlane({
      repoRoot,
      runtimeDir,
      team,
      devRepository: yield* devRepository(sha),
    });
    yield* Console.log(`control plane: ${origin}, plane ${planeId}, deployment development`);
    const client = makeClient(origin, team.jwt);
    const executorId = `local-ci-${hostname().split(".")[0]}`;
    const identity = yield* startDevice({
      repoRoot,
      binaries,
      client,
      origin,
      planeId,
      runtimeDir,
      workspaceRoot,
      executorId,
    });
    yield* Console.log(`enrolled ${executorId} with a ${identity.key_store} key`);
    const { execution_id: executionId, class: className } = yield* client.dispatchCheck({
      repository: REPOSITORY,
      sha,
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
      return yield* new LocalCiExit({ code });
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
  Console.error(`ci:local stopped: ${message}`).pipe(
    Effect.andThen(Effect.fail(new LocalCiExit({ code: EXIT_NO_VERDICT }))),
  );

const command = Command.make(
  "ci:local",
  { ref: Argument.String("ref").pipe(Argument.withDefault("HEAD")) },
  ({ ref }) => ciLocal(ref),
);

if (process.argv[1] === fileURLToPath(import.meta.url))
  Command.run(command, { version: "0.0.1" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
