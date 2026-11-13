// The workspace rule on FlareDispatch's composed runner: the catalogue's runner entry, as the device executor starts it
// for each lease, running the `check` gate job through `processGateExec` against a real git repository. Epoch 1 dies
// mid-job and leaves its workspace behind; epoch 2 of the same execution must start from an empty workspace and fetch
// the commit again. A `git` shim ahead of the real one on the job's PATH records every git call's directory and how
// many entries that directory held when the call began.
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import RUN_DIGESTS from "@fractalboxdev/flare-dispatch-catalog/run-digests" with { type: "json" };

const ENTRY = join(import.meta.dirname, "../../catalog/src/runner-entry.ts");
const EXECUTION = "01JCACHE003";

let root: string;
let workspaces: string;
let repo: string;
let sha: string;
let shimLog: string;
let shimDir: string;
let socketPath: string;
let jobSocket: Server;

/** The device executor's side of the execution socket: it prepares and stops each job (MAMEKO-ISO-044). */
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
  root = realpathSync(mkdtempSync(join(tmpdir(), "fd-conf-workspace-")));
  socketPath = join(root, "job.sock");
  jobSocket = await startJobSocket(socketPath);
  workspaces = join(root, "workspaces");
  mkdirSync(workspaces);
  repo = join(root, "repo");
  mkdirSync(repo);
  git("init", "-q");
  writeFileSync(join(repo, "marker.txt"), "committed\n");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  sha = git("rev-parse", "HEAD");

  const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  shimLog = join(root, "git-calls.tsv");
  shimDir = join(root, "shim");
  mkdirSync(shimDir);
  writeFileSync(
    join(shimDir, "git"),
    [
      "#!/bin/sh",
      `printf '%s\\t%s\\t%s\\n' "$(pwd -P)" "$(ls -A | wc -l | tr -d ' ')" "$*" >> '${shimLog}'`,
      `exec '${realGit}' "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(shimDir, "git"), 0o755);
});

afterAll(() => {
  jobSocket?.close();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

interface GitCall {
  readonly dir: string;
  readonly entriesBefore: number;
  readonly args: string;
}

const gitCalls = (): readonly GitCall[] =>
  existsSync(shimLog)
    ? readFileSync(shimLog, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
          const [dir, entries, args] = line.split("\t");
          return { dir: dir!, entriesBefore: Number(entries), args: args ?? "" };
        })
    : [];

/** Starts the runner entry for one epoch of the execution, with its own journal, as a fresh executor does. */
const runEpoch = (epoch: number, steps: readonly { label: string; command: string }[]) =>
  new Promise<{ readonly lines: readonly string[]; readonly signal: NodeJS.Signals | null }>(
    (resolve) => {
      const child = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          ENTRY,
          "--journal",
          join(root, `epoch-${epoch}.sqlite`),
          "--content-socket",
          socketPath,
        ],
        {
          env: {
            PATH: `${shimDir}:${process.env["PATH"]}`,
            HOME: root,
            FD_WORKSPACE_ROOT: workspaces,
            FD_DEPLOYMENT: "development",
          },
          stdio: ["pipe", "pipe", "ignore"],
        },
      );
      let stdout = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.once("close", (_code, signal) =>
        resolve({ lines: stdout.split("\n").filter((l) => l !== ""), signal }),
      );
      child.stdin.write(
        `${JSON.stringify({
          workflow_version: 1,
          execution_id: EXECUTION,
          run: "check",
          run_digest: RUN_DIGESTS.check,
          run_version: "2.0.0",
          scope_id: "scope",
          request_context: null,
          class: "batch",
          epoch,
          deadline_at: Date.now() + 60_000,
          attempt: 0,
          input: { repo: `file://${repo}`, sha, ref: "main", steps },
        })}\n`,
      );
    },
  );

const workspaceOf = (calls: readonly GitCall[]): string => {
  const init = calls.find((c) => c.args.startsWith("init"));
  expect(init).toBeDefined();
  return init!.dir;
};

describe("a gate job reclaimed to epoch 2 on the composed runner", () => {
  it("[FD-CACHE-003] starts from an empty workspace and fetches the commit again, whatever epoch 1 left behind", async () => {
    // Epoch 1 writes into its workspace and then its runner is killed: no scope closes, so the workspace stays.
    const first = await runEpoch(1, [
      {
        label: "build",
        command:
          "echo from-epoch-1 > leftover.txt && mkdir -p target && echo out > target/bin && kill -KILL $PPID",
      },
    ]);
    expect(first.signal).toBe("SIGKILL");
    expect(first.lines).toEqual([]);
    const epoch1 = gitCalls();
    const epoch1Workspace = workspaceOf(epoch1);
    expect(readFileSync(join(epoch1Workspace, "leftover.txt"), "utf8")).toBe("from-epoch-1\n");
    expect(existsSync(join(epoch1Workspace, "target", "bin"))).toBe(true);

    writeFileSync(shimLog, "");
    const second = await runEpoch(2, [
      {
        label: "build",
        command: [
          "test ! -e leftover.txt",
          "test ! -e target",
          'test -z "$(git status --porcelain --ignored)"',
          `test "$(git rev-parse HEAD)" = ${sha}`,
        ].join(" && "),
      },
    ]);
    expect(second.lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      expect.objectContaining({ result: { _tag: "success" } }),
    ]);

    const epoch2 = gitCalls();
    const epoch2Workspace = workspaceOf(epoch2);
    expect(epoch2Workspace).not.toBe(epoch1Workspace);
    expect(epoch2Workspace.startsWith(`${workspaces}/`)).toBe(true);
    // The first git call of epoch 2 starts in a directory with no entry at all.
    expect(epoch2.find((c) => c.dir === epoch2Workspace)).toMatchObject({
      args: expect.stringMatching(/^init/),
      entriesBefore: 0,
    });
    // The commit comes from a fetch of the repository into that workspace.
    expect(
      epoch2
        .filter((c) => c.dir === epoch2Workspace && c.args.startsWith("fetch"))
        .map((c) => c.args),
    ).toEqual([`fetch -q --depth 1 origin ${sha}`]);
    // Epoch 2 removes its own workspace on release; epoch 1's is the only one left.
    expect(readdirSync(workspaces).map((d) => join(workspaces, d))).toEqual([epoch1Workspace]);
  }, 60_000);
});
