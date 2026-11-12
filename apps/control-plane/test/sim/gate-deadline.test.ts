// A gate run past its execution's deadline, from dispatch to verdict: the control plane Worker on workerd admits a
// `check` dispatch and grants its lease to the test's device socket, and the catalogue's runner entry runs the lease as
// the device executor starts it, against a real git repository.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUD,
  connect,
  endStandingClaim,
  hello,
  newDevice,
  OPERATOR,
  PLANE,
  registration,
  startAccessTeam,
  type AccessTeam,
} from "../support.ts";

const RUNNER_ENTRY = join(import.meta.dirname, "../../../../packages/catalog/src/runner-entry.ts");
const MANIFEST = JSON.stringify({
  version: 1,
  runs: [
    {
      recipe: "check",
      triggers: ["dispatch"],
      params: { steps: [{ label: "x", command: "true" }] },
    },
  ],
});

let team: AccessTeam;
let mf: Miniflare;
let root: string;
let repo: string;
let sha: string;
let jobSocket: Server;
let socketPath: string;

/** The device executor's side of the execution socket: it prepares the job's workspace and stops its commands. */
const startJobSocket = (path: string) =>
  new Promise<Server>((resolve) => {
    const server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
          const m = JSON.parse(buffer.slice(0, i)) as { type: string; id?: string };
          buffer = buffer.slice(i + 1);
          const type =
            m.type === "job.prepare"
              ? "job.prepare.ok"
              : m.type === "job.stop"
                ? "job.stop.ok"
                : "socket.error";
          socket.write(`${JSON.stringify({ type, ref: m.id })}\n`);
        }
      });
    });
    server.listen(path, () => resolve(server));
  });

const git = (...args: readonly string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"],
      HOME: root,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "fd-gate-deadline-"));
  socketPath = join(root, "job.sock");
  jobSocket = await startJobSocket(socketPath);
  execFileSync("mkdir", [join(root, "workspaces")]);
  repo = join(root, "repo");
  execFileSync("mkdir", [repo]);
  git("init", "-q");
  writeFileSync(join(repo, "marker.txt"), "committed\n");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  sha = git("rev-parse", "HEAD");

  team = await startAccessTeam();
  const bundle = await build({
    entryPoints: [join(import.meta.dirname, "../../src/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    external: ["cloudflare:*"],
  });
  mf = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.js", contents: bundle.outputFiles[0]!.text }],
    compatibilityDate: "2026-05-01",
    d1Databases: { DB: "control-plane" },
    durableObjects: {
      CHANNEL: { className: "ExecutorChannel", useSQLite: true },
      EXECUTION: { className: "ExecutionEngine", useSQLite: true },
      EPOCH_ANCHOR: { className: "EpochAnchor", useSQLite: true },
      MONITOR: { className: "LivenessMonitor", useSQLite: true },
      CACHE_LEDGER: { className: "CacheLedger", useSQLite: true },
    },
    r2Buckets: ["CACHE"],
    bindings: {
      DEPLOYMENT: "development",
      PLANE_ID: PLANE,
      ACCESS_TEAM_DOMAIN: team.teamDomain,
      ACCESS_AUD: AUD,
      OPERATORS: JSON.stringify([OPERATOR]),
      DISPATCHERS: JSON.stringify([OPERATOR]),
      FD_DEV_REPOSITORY: JSON.stringify({
        repository: "fractalboxdev/flare-dispatch",
        installation: 1,
        default_branch: "main",
        head: sha,
        confidentiality: "non-confidential",
        files: { ".github/flare-dispatch.json": Buffer.from(MANIFEST).toString("base64") },
      }),
    },
  });
  await mf.ready;
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  await team?.close();
  jobSocket?.close();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** The lease's run payload through the runner entry, as the device executor starts it; its one result line. */
const runLease = (lease: Record<string, unknown>) =>
  new Promise<unknown>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        RUNNER_ENTRY,
        "--journal",
        join(root, `${crypto.randomUUID()}.sqlite`),
        "--content-socket",
        socketPath,
      ],
      {
        env: {
          PATH: process.env["PATH"],
          HOME: process.env["HOME"],
          FD_WORKSPACE_ROOT: join(root, "workspaces"),
          FD_DEPLOYMENT: "development",
        },
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.once("error", reject);
    child.once("close", () => {
      const line = stdout.split("\n").find((l) => l !== "");
      resolve(line === undefined ? null : (JSON.parse(line) as { result: unknown }).result);
    });
    child.stdin.write(
      `${JSON.stringify({
        workflow_version: lease["workflow_version"],
        execution_id: lease["execution_id"],
        run: lease["run"],
        run_version: lease["run_version"],
        scope_id: lease["scope_id"],
        request_context: lease["request_context"],
        class: lease["class"],
        epoch: lease["epoch"],
        deadline_at: lease["deadline_at"],
        attempt: 0,
        input: lease["inputs"],
      })}\n`,
    );
  });

describe("a gate job at the execution's deadline", () => {
  it("[FD-GATE-007] stops a command still running at the deadline admission wrote and records failure: deadline", async () => {
    const response = await mf.dispatchFetch("http://x/v1/dispatch/check", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-access-jwt-assertion": await team.jwt(OPERATOR),
      },
      body: JSON.stringify({
        repository: "fractalboxdev/flare-dispatch",
        sha,
        inputs: {
          repo: `file://${repo}`,
          sha,
          ref: "refs/heads/main",
          steps: [{ label: "slow", command: "sleep 60", timeoutSec: 60 }],
        },
      }),
    });
    expect(response.status).toBe(202);
    const { execution_id: id, class: className } = (await response.json()) as {
      execution_id: string;
      class: string;
    };
    // The execution's deadline falls 4 s from now, well inside the step's own 60 s timeout.
    const deadline = Date.now() + 4_000;
    const db = await mf.getD1Database("DB");
    await db.batch([
      db.prepare("update executions set deadline_at = ? where id = ?").bind(deadline, id),
      db.prepare("update placements set deadline_at = ? where execution_id = ?").bind(deadline, id),
    ]);

    const device = await newDevice();
    await mf.dispatchFetch("http://x/v1/executors/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-access-jwt-assertion": await team.jwt(OPERATOR),
      },
      body: JSON.stringify(registration("mac-deadline", device.identity)),
    });
    const socket = await connect(mf, "mac-deadline", device.keys);
    socket.send(hello("mac-deadline"));
    await socket.next("session.welcome");
    socket.send({ type: "exec.claim", id: "c1", free: { [className]: 1 } });
    const lease = await socket.next("exec.lease");
    expect(lease).toMatchObject({ execution_id: id, deadline_at: deadline });
    await endStandingClaim(socket);

    const started = Date.now();
    expect(await runLease(lease)).toEqual({ _tag: "failure", reason: "deadline" });
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);
});
