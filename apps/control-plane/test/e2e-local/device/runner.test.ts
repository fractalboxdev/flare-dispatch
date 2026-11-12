// The run catalogue's runner entry on the device path (specs/run-model.md § Catalogue, specs/verification.md
// § V-E2E-LOCAL): the control plane under `wrangler dev` for the development deployment, the key helper and mameko's
// device executor started with `packages/catalog/src/runner-entry.ts` as its runner main. Each job command records its
// process ancestry, so the test reads which program ran the run around it.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const RUNNER_ENTRY = join(REPO_ROOT, "packages/catalog/src/runner-entry.ts");
const REPOSITORY = "acme/widgets";
const REF = "refs/heads/main";
const MANIFEST_PATH = ".github/flare-dispatch.json";
const MANIFEST = {
  version: 1,
  runs: [
    {
      recipe: "check",
      triggers: ["dispatch"],
      params: { steps: [{ label: "x", command: "true" }] },
    },
    { recipe: "gate-job", triggers: ["dispatch"] },
  ],
};

const VERDICT_WAIT_MS = 150_000;
const POLL_MS = 500;

let scope: Scope.Closeable;
let client: ControlPlaneClient;
let root: string;
let repo: string;
let evidence: string;
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
  root = mkdtempSync(join(tmpdir(), "fd-e2e-runner-"));
  repo = join(root, "repo");
  evidence = join(root, "evidence");
  const workspaceRoot = join(root, "work");
  for (const dir of [repo, evidence, workspaceRoot]) mkdirSync(dir, { recursive: true });
  git("init", "-q", "-b", "main");
  mkdirSync(join(repo, ".github"));
  writeFileSync(join(repo, MANIFEST_PATH), JSON.stringify(MANIFEST));
  git("add", ".");
  git("commit", "-q", "-m", "e2e");
  sha = git("rev-parse", "HEAD");

  const runtimeDir = join(REPO_ROOT, ".tmp/e2e-local-device", `runner-${Date.now()}`);
  mkdirSync(runtimeDir, { recursive: true });
  scope = Effect.runSync(Scope.make());
  const stack = await Effect.runPromise(
    startDeviceStack({
      repoRoot: REPO_ROOT,
      runtimeDir,
      workspaceRoot,
      executorId: "e2e-runner-device",
      devRepository: {
        repository: REPOSITORY,
        installation: 1,
        default_branch: "main",
        head: sha,
        files: { [MANIFEST_PATH]: Buffer.from(JSON.stringify(MANIFEST)).toString("base64") },
        confidentiality: "non-confidential",
      },
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
      idempotencyKey: `e2e-runner-${process.pid}-${dispatched}`,
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

/** A shell command that writes the command line of itself and of every ancestor process, one per line, to `path`. */
const recordAncestry = (path: string) =>
  [
    "p=$$",
    `while [ "$p" -gt 1 ]; do ps -ww -o args= -p "$p" >> ${path}; p=$(ps -o ppid= -p "$p" | tr -d ' '); done`,
  ].join("; ");

/**
 * The runner child that ran a job: the command line, split on whitespace, of the job's ancestor whose parent is the
 * device executor.
 */
const runnerChildOf = (path: string): readonly string[] => {
  const ancestry = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/));
  const device = ancestry.findIndex((args) => args[0]!.endsWith("/mameko-device-executor"));
  expect(device, ancestry.map((args) => args.join(" ")).join("\n")).toBeGreaterThan(0);
  return ancestry[device - 1]!;
};

describe("the run catalogue's runner entry", () => {
  it("[FD-RUN-063] the device's runner child for every run is the catalogue's one entry, which runs it from the registry", async () => {
    const out = join(evidence, "ancestry");
    mkdirSync(out, { recursive: true });
    const check = await verdictOf("check", {
      steps: [{ label: "ancestry", command: recordAncestry(`${out}/check`) }],
    });
    const job = await verdictOf("gate-job", {
      key: "ancestry",
      command: recordAncestry(`${out}/gate-job`),
    });
    // Both runs reached the verdict their run program returns, not `RunNotInCatalog`: the registry the entry passes
    // `runnerMain` holds each.
    expect(check).toMatchObject({ status: "done", verdict: "success" });
    expect(job).toMatchObject({ status: "done", verdict: "success" });
    // Each job ran under the device's runner child, and that child is Node running the catalogue's runner entry.
    for (const run of ["check", "gate-job"]) {
      const runner = runnerChildOf(`${out}/${run}`);
      expect(runner[0], run).toBe(process.execPath);
      expect(
        runner.find((arg, i) => i > 0 && !arg.startsWith("-")),
        run,
      ).toBe(RUNNER_ENTRY);
    }
  });
});
