// The `check` run through the real runner entry, as the device executor starts it: a child process with a payload line
// on stdin and one result line on stdout, against a real git repository.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommandExit, runCommand } from "./command.ts";
import { deploymentOf, lookupRun, type CheckStep } from "./index.ts";

const entry = fileURLToPath(new URL("./runner-entry.ts", import.meta.url));

let root: string;
let workspaces: string;
let repo: string;
let sha: string;

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

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "fd-catalog-test-"));
  workspaces = join(root, "workspaces");
  execFileSync("mkdir", [workspaces]);
  repo = join(root, "repo");
  execFileSync("mkdir", [repo]);
  git("init", "-q");
  writeFileSync(join(repo, "marker.txt"), "committed\n");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  sha = git("rev-parse", "HEAD");
  // A later commit, so a run of `sha` proves the checkout takes that commit and not the branch head.
  writeFileSync(join(repo, "marker.txt"), "moved on\n");
  git("commit", "-q", "-am", "later");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Finished {
  readonly lines: readonly string[];
  readonly code: number | null;
}

const runEntry = (
  input: unknown,
  env: Readonly<Record<string, string>> = { FD_DEPLOYMENT: "development" },
): Promise<Finished> =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        entry,
        "--journal",
        join(root, `${crypto.randomUUID()}.sqlite`),
      ],
      {
        env: {
          PATH: process.env["PATH"],
          HOME: process.env["HOME"],
          FD_WORKSPACE_ROOT: workspaces,
          ...env,
        },
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.once("close", (code) =>
      resolve({ lines: stdout.split("\n").filter((l) => l !== ""), code }),
    );
    child.stdin.write(
      `${JSON.stringify({
        workflow_version: 1,
        execution_id: "01JCHECK",
        run: "check",
        run_version: "2.0.0",
        scope_id: "scope",
        request_context: null,
        class: "batch",
        epoch: 2,
        deadline_at: Date.now() + 60_000,
        attempt: 0,
        input,
      })}\n`,
    );
  });

const check = async (steps: readonly CheckStep[], at = sha) => {
  const { lines } = await runEntry({ repo: `file://${repo}`, sha: at, ref: "main", steps });
  expect(lines).toHaveLength(1);
  return (JSON.parse(lines[0]!) as { result: unknown }).result;
};

describe("check through the runner entry", () => {
  it("FD-GATE-019 runs every step in a checkout of that commit and answers one result line", async () => {
    await expect(
      check([
        { label: "stdout", command: "echo not-json" },
        { label: "commit", command: "grep -q committed marker.txt" },
      ]),
    ).resolves.toEqual({ _tag: "success" });
  });

  it("FD-GATE-003 names the failing step and runs no step after it", async () => {
    const after = join(root, "ran-after");
    await expect(
      check([
        { label: "lint", command: "exit 3" },
        { label: "test", command: `touch ${after}` },
      ]),
    ).resolves.toEqual({ _tag: "failure", reason: "finding: lint: exit 3" });
    expect(existsSync(after)).toBe(false);
  });

  it("FD-GATE-006 kills a step's process group at its timeout", async () => {
    const survivor = join(root, "survivor");
    await expect(
      check([{ label: "slow", command: `(sleep 2; touch ${survivor}) & sleep 30`, timeoutSec: 1 }]),
    ).resolves.toEqual({ _tag: "failure", reason: "finding: slow: timeout" });
    await new Promise((r) => setTimeout(r, 2_200));
    expect(existsSync(survivor)).toBe(false);
  });

  it("FD-GATE-014 leaves the executor's environment out of a job, and FD-GATE-013 sets its fields", async () => {
    const { lines } = await runEntry(
      {
        repo: `file://${repo}`,
        sha,
        ref: "refs/heads/main",
        steps: [
          {
            label: "env",
            command: `test -z "$FD_TEST_SECRET" && test "$FD_SHA" = ${sha} && test "$FD_JOB" = env && test "$FD_REF" = refs/heads/main`,
          },
        ],
      },
      { FD_DEPLOYMENT: "development", FD_TEST_SECRET: "held by the executor" },
    );
    expect(JSON.parse(lines[0]!)).toMatchObject({ result: { _tag: "success" } });
  });

  it("reports a commit the repository lacks as an infrastructure failure, not a finding", async () => {
    await expect(
      check([{ label: "never", command: "true" }], "0".repeat(40)),
    ).resolves.toMatchObject({ _tag: "failure", reason: "infra: checkout: exit 128" });
  });

  it("removes every clean directory it made", () => {
    expect(readdirSync(workspaces)).toEqual([]);
  });

  it("a runner outside the development deployment refuses the run", async () => {
    const environments: readonly Record<string, string>[] = [{ FD_DEPLOYMENT: "production" }, {}];
    for (const env of environments) {
      const { lines, code } = await runEntry(
        { repo: `file://${repo}`, sha, ref: "main", steps: [{ label: "x", command: "true" }] },
        env,
      );
      expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
        { type: "runner.refused", reason: "RunNotInCatalog" },
      ]);
      expect(code).toBe(2);
    }
  });
});

describe("runCommand", () => {
  it("FD-GATE-008 stops a command past its output limit", async () => {
    const exit = await Effect.runPromise(
      runCommand({
        command: "yes",
        cwd: tmpdir(),
        env: { PATH: process.env["PATH"] ?? "" },
        timeoutMs: 10_000,
        outputLimitBytes: 16,
      }),
    );
    expect(exit).toEqual(CommandExit.OverLimit());
  });

  it("answers a command killed by a signal", async () => {
    const exit = await Effect.runPromise(
      runCommand({ command: "kill -KILL $$", cwd: tmpdir(), env: {}, timeoutMs: 10_000 }),
    );
    expect(exit).toEqual(CommandExit.Signalled({ signal: "SIGKILL" }));
  });

  it("answers a directory that does not exist as not started", async () => {
    const exit = await Effect.runPromise(
      runCommand({ command: "true", cwd: "/nonexistent/dir", env: {}, timeoutMs: 10_000 }),
    );
    expect(CommandExit.$is("NotStarted")(exit)).toBe(true);
  });
});

describe("lookupRun", () => {
  it("offers a host execution only under development", () => {
    expect(lookupRun("development", "check")._tag).toBe("Available");
    expect(lookupRun("production", "check")._tag).toBe("HostExecutionRefused");
    expect(lookupRun("development", "constructor")._tag).toBe("NotInCatalogue");
  });

  it("treats anything but the word development as production", () => {
    expect(deploymentOf("development")).toBe("development");
    expect(deploymentOf(undefined)).toBe("production");
    expect(deploymentOf("dev")).toBe("production");
  });
});
