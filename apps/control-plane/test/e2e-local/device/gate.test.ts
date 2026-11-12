// The gate recipes on the device path (specs/runs/gate.md, specs/verification.md § V-E2E-LOCAL): the control plane
// under `wrangler dev` for the development deployment, the key helper and mameko's device executor, whose runner
// child runs `check` and `gate-job` on the host. The repository is a local git repository the jobs fetch over
// `file://`; each job command writes what it observes under an evidence directory the test reads after the verdict.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ControlPlaneClient,
  ExecutionView,
} from "@fractalboxdev/flare-dispatch-local-ci/client";
import { startDeviceStack } from "@fractalboxdev/flare-dispatch-local-ci/stack";
import { Effect, Exit, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../../../../..");
const REPOSITORY = "acme/widgets";
const REF = "refs/heads/main";
const MANIFEST_PATH = ".github/flare-dispatch.json";
const MANIFEST = {
  version: 1,
  runs: [
    {
      recipe: "check",
      triggers: ["dispatch"],
      params: { steps: [{ label: "test", command: "true" }] },
    },
    { recipe: "gate-job", triggers: ["dispatch"] },
  ],
};
/** A file the commit holds and no other commit does, so a job can tell its checkout is of this commit. */
const COMMITTED_FILE = "committed.txt";

/** Values only the device executor's environment holds; none may reach a job (FD-GATE-014). */
const EXECUTOR_SECRET = `fd-e2e-executor-secret-${process.pid}-${Date.now()}`;
const EXECUTOR_TOKEN = `ghs_${"e2e".repeat(12)}`;

const VERDICT_WAIT_MS = 150_000;
const POLL_MS = 500;

let scope: Scope.Closeable;
let client: ControlPlaneClient;
let root: string;
let repo: string;
let evidence: string;
let workspaceRoot: string;
let sha: string;

const git = (...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=e2e",
      "-c",
      "user.email=e2e@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: repo, encoding: "utf8" },
  ).trim();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "fd-e2e-device-"));
  repo = join(root, "repo");
  evidence = join(root, "evidence");
  workspaceRoot = join(root, "work");
  for (const dir of [repo, evidence, workspaceRoot]) mkdirSync(dir, { recursive: true });
  git("init", "-q", "-b", "main");
  mkdirSync(join(repo, ".github"));
  writeFileSync(join(repo, MANIFEST_PATH), JSON.stringify(MANIFEST));
  writeFileSync(join(repo, COMMITTED_FILE), `${root}\n`);
  git("add", ".");
  git("commit", "-q", "-m", "e2e");
  sha = git("rev-parse", "HEAD");

  const runtimeDir = join(REPO_ROOT, ".tmp/e2e-local-device", String(Date.now()));
  mkdirSync(runtimeDir, { recursive: true });
  scope = Effect.runSync(Scope.make());
  const stack = await Effect.runPromise(
    startDeviceStack({
      repoRoot: REPO_ROOT,
      runtimeDir,
      workspaceRoot,
      executorId: "e2e-device",
      devRepository: {
        repository: REPOSITORY,
        installation: 1,
        default_branch: "main",
        head: sha,
        files: { [MANIFEST_PATH]: Buffer.from(JSON.stringify(MANIFEST)).toString("base64") },
        confidentiality: "non-confidential",
      },
      deviceEnv: { FD_E2E_EXECUTOR_SECRET: EXECUTOR_SECRET, GITHUB_TOKEN: EXECUTOR_TOKEN },
    }).pipe(Scope.provide(scope)),
  );
  client = stack.client;
});

afterAll(async () => {
  if (scope !== undefined) await Effect.runPromise(Scope.close(scope, Exit.void));
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

let dispatched = 0;

/** Dispatches `run` with `inputs` on the commit and follows the coordinator's record until it is `done`. */
const verdictOf = async (run: string, inputs: Record<string, unknown>): Promise<ExecutionView> => {
  dispatched += 1;
  const { execution_id } = await Effect.runPromise(
    client.dispatch({
      run,
      repository: REPOSITORY,
      sha,
      inputs: { repo: `file://${repo}`, sha, ref: REF, ...inputs },
      // Each dispatch is its own execution; the commit alone would key every one to the first.
      idempotencyKey: `e2e-${process.pid}-${dispatched}`,
    }),
  );
  const until = Date.now() + VERDICT_WAIT_MS;
  while (Date.now() < until) {
    const view = await Effect.runPromise(client.execution(execution_id));
    if (view.status === "done") return view;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`execution ${execution_id} reached no verdict in ${VERDICT_WAIT_MS / 1000} s`);
};

/** A `check` of one step. */
const check = (label: string, command: string, timeoutSec?: number) =>
  verdictOf("check", {
    steps: [{ label, command, ...(timeoutSec === undefined ? {} : { timeoutSec }) }],
  });

/** An evidence directory for one test, which job commands write into by its absolute path. */
const evidenceDir = (name: string) => {
  const dir = join(evidence, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const lines = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);

/** `NAME=value` lines of `env` output, as a record. */
const envOf = (path: string): Record<string, string> =>
  Object.fromEntries(
    lines(path)
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Every file under `dir`, recursively. */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(join(dir, entry.name))
      : entry.isFile()
        ? [join(dir, entry.name)]
        : [],
  );

describe("gate jobs on the device path", () => {
  it("[FD-GATE-002] records success for a job command that exits 0", async () => {
    const out = evidenceDir("exit-zero");
    const view = await check("pass", `echo ran > ${out}/ran; exit 0`);
    expect(existsSync(join(out, "ran"))).toBe(true);
    expect(view).toMatchObject({ status: "done", verdict: "success" });
  });

  it("[FD-GATE-003] records failure with the reason exit: <code> for a job command that exits non-zero", async () => {
    const out = evidenceDir("exit-three");
    const view = await check("fail", `echo ran > ${out}/ran; exit 3`);
    expect(existsSync(join(out, "ran"))).toBe(true);
    expect(view).toMatchObject({ status: "done", verdict: "failure", reason: "exit: 3" });
  });

  it("[FD-GATE-006] [FD-GATE-019] kills the process group of a job past its timeoutSec and records timeout: job", async () => {
    const out = evidenceDir("timeout");
    // A member of the job's group that ignores SIGTERM: only the group's SIGKILL ends it.
    const command = [
      `(trap '' TERM; exec sleep 300) >/dev/null 2>&1 &`,
      `echo $! > ${out}/member.pid`,
      `echo $$ > ${out}/shell.pid`,
      "wait",
    ].join("\n");
    const started = Date.now();
    const view = await check("slow", command, 2);
    expect(view).toMatchObject({ status: "done", verdict: "failure", reason: "timeout: job" });
    // The entry's timeoutSec, not the 600 s default, bounds the job.
    expect(Date.now() - started).toBeLessThan(30_000);
    const pids = [`${out}/member.pid`, `${out}/shell.pid`].map((p) => Number(lines(p)[0]));
    for (const pid of pids) expect(pid).toBeGreaterThan(0);
    const until = Date.now() + 10_000;
    while (pids.some(alive) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    expect(pids.filter(alive)).toEqual([]);
  });

  it("[FD-GATE-013] sets FD_REPO, FD_SHA, FD_REF and FD_JOB in the job's environment", async () => {
    const out = evidenceDir("fd-env");
    const view = await check("envcheck", `env > ${out}/env`);
    expect(view.verdict).toBe("success");
    expect(envOf(join(out, "env"))).toMatchObject({
      FD_REPO: `file://${repo}`,
      FD_SHA: sha,
      FD_REF: REF,
      FD_JOB: "envcheck",
    });
  });

  it("[FD-GATE-014] places no secret of the executor in the job's environment, arguments or files", async () => {
    const out = evidenceDir("no-secret");
    const command = [
      `env > ${out}/env`,
      `ps -o args= -p $$ > ${out}/args`,
      `mkdir ${out}/workspace`,
      `cp -R . ${out}/workspace/`,
    ].join(" && ");
    const view = await check("nosecret", command);
    expect(view.verdict).toBe("success");
    const env = envOf(join(out, "env"));
    // The job ran with an environment, and it is not the executor's.
    expect(env["FD_JOB"]).toBe("nosecret");
    expect(env["FD_E2E_EXECUTOR_SECRET"]).toBeUndefined();
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
    const files = [join(out, "env"), join(out, "args"), ...filesUnder(join(out, "workspace"))];
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toContain(EXECUTOR_SECRET);
      expect(text, file).not.toContain(EXECUTOR_TOKEN);
    }
  });

  it("[FD-GATE-019] runs the check command once in a checkout of the execution's commit", async () => {
    const out = evidenceDir("checkout");
    const command = [
      `echo run >> ${out}/runs`,
      `git rev-parse HEAD > ${out}/head`,
      `cp ${COMMITTED_FILE} ${out}/committed`,
      `pwd > ${out}/cwd`,
    ].join(" && ");
    const view = await check("checkout", command);
    expect(view.verdict).toBe("success");
    expect(lines(join(out, "runs"))).toEqual(["run"]);
    expect(lines(join(out, "head"))).toEqual([sha]);
    expect(readFileSync(join(out, "committed"), "utf8")).toBe(`${root}\n`);
    // A checkout of its own, not the repository the commit came from.
    expect(lines(join(out, "cwd"))[0]).not.toBe(repo);
  });

  it("[FD-GATE-027] runs a gate job's install once in the job's own workspace before the job command", async () => {
    const out = evidenceDir("install");
    const job = (key: string) =>
      verdictOf("gate-job", {
        key,
        install: `pwd >> ${out}/${key}.install && echo installed > .fd-e2e-installed`,
        command: `test -f .fd-e2e-installed && pwd >> ${out}/${key}.command`,
      });
    const views = [await job("shard-a"), await job("shard-b")];
    for (const view of views) expect(view).toMatchObject({ status: "done", verdict: "success" });
    const workspaces = ["shard-a", "shard-b"].map((key) => {
      const installs = lines(join(out, `${key}.install`));
      const commands = lines(join(out, `${key}.command`));
      expect(installs).toHaveLength(1);
      // The command found what the install left in its workspace, so the install ran first and in the same place.
      expect(commands).toEqual(installs);
      return installs[0];
    });
    expect(new Set(workspaces).size).toBe(2);
  });
});
