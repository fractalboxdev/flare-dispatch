// The socket client against mameko's local scheduler. The scheduler is the `mameko-local-scheduler` binary built from
// the pinned mameko source when `cargo` builds it here; on a machine without a Rust toolchain it is a socket server
// that answers as mameko's local-scheduler.md § Process and keys and `crates/local-scheduler/src/server.rs` specify.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fileLedger,
  gitWorkingTree,
  LOCAL_ID,
  scopeOfRemote,
  socketScheduler,
  type LocalScheduler,
} from "./local-scheduler.ts";

const REPO = join(import.meta.dirname, "..", "..", "..");
const MAMEKO = join(REPO, "vendor", "mameko");
const TARGET = join(REPO, ".tmp", "cargo-target");

/** The capacity lease the scheduler serves under: this process's uid is the member `dev`. */
const LEASE = {
  classes: ["rehearsal", "dev-loop"],
  members: [{ uid: process.getuid?.() ?? 0, member: "dev" }],
  memory_mib: 8192,
  offline: false,
  slots: [{ pool: "lean", slots: 2 }],
  local_model_streams: 0,
  token_allowance: 250_000,
};

/** The `mameko-local-scheduler` binary, built from the pinned source, or null when no Rust toolchain builds it. */
const buildScheduler = (): string | null => {
  const built = spawnSync("cargo", ["build", "-q", "-p", "mameko-local-scheduler"], {
    cwd: MAMEKO,
    env: { ...process.env, CARGO_TARGET_DIR: TARGET },
    stdio: "ignore",
  });
  return built.status === 0 ? join(TARGET, "debug", "mameko-local-scheduler") : null;
};

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A socket server with mameko's wire format: one JSON object per line, answered on one line with the request's `id`
 * as `ref`; every peer is the lease's one member, and a submission matching a live execution attaches to it.
 */
const protocolServer = (path: string): Promise<Server> => {
  const entries: { execution: string; key: string; submitters: string[] }[] = [];
  const mint = () => {
    let id = "";
    for (let t = Date.now(), i = 0; i < 10; i++, t = Math.floor(t / 32))
      id = CROCKFORD[t % 32]! + id;
    for (let i = 0; i < 16; i++) id += CROCKFORD[Math.floor(Math.random() * 32)]!;
    return `local-${id}`;
  };
  const answer = (r: Record<string, unknown>): Record<string, unknown> => {
    switch (r["type"]) {
      case "submit": {
        if (!LEASE.classes.includes(String(r["class"])))
          return ["dev-loop", "swarm", "rehearsal", "background"].includes(String(r["class"]))
            ? { type: "error", code: "class-not-allowed" }
            : { type: "error", code: "invalid", field: "class" };
        const key = JSON.stringify([r["scope"], r["files"], r["run"], r["inputs_digest"]]);
        const submission = mint();
        const live = entries.find((e) => e.key === key);
        if (live !== undefined) {
          live.submitters.push(submission);
          return {
            type: "submit.ok",
            execution_id: live.execution,
            submission_id: submission,
            attached: true,
          };
        }
        entries.push({ execution: submission, key, submitters: [submission] });
        return {
          type: "submit.ok",
          execution_id: submission,
          submission_id: submission,
          position: entries.length - 1,
          attached: false,
        };
      }
      case "queue":
        return { type: "queue.ok", executions: entries.map((e) => e.execution) };
      case "status":
        return entries.some((e) => e.execution === r["execution_id"])
          ? { type: "status.ok", state: "queued" }
          : { type: "error", code: "not-found" };
      case "cancel": {
        const i = entries.findIndex((e) => e.execution === r["execution_id"]);
        if (i < 0) return { type: "error", code: "not-found" };
        const entry = entries[i]!;
        entry.submitters = entry.submitters.filter((s) => s !== r["submission_id"]);
        if (entry.submitters.length > 0) return { type: "cancel.ok", stopped: false };
        entries.splice(i, 1);
        return { type: "cancel.ok", stopped: true };
      }
      case "lease":
        return {
          type: "lease.ok",
          offline: LEASE.offline,
          slots: LEASE.slots,
          token_allowance: LEASE.token_allowance,
        };
      default:
        return { type: "error", code: "unknown-request" };
    }
  };
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
          const request = JSON.parse(buffer.slice(0, i)) as Record<string, unknown>;
          buffer = buffer.slice(i + 1);
          socket.write(`${JSON.stringify({ ...answer(request), ref: request["id"] })}\n`);
        }
      });
    });
    server.listen(path, () => resolve(server));
  });
};

/** Resolves once the socket at `path` accepts a connection. */
const accepting = async (path: string) => {
  for (let i = 0; i < 200; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect(path);
      s.once("connect", () => (s.destroy(), resolve(true)));
      s.once("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`the local scheduler never listened on ${path}`);
};

const git = (dir: string, ...args: string[]) =>
  spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();

let dir: string;
let socket: string;
let child: ChildProcess | undefined;
let server: Server | undefined;
let scheduler: LocalScheduler["Service"];
let served: "mameko-local-scheduler" | "protocol server";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "fd-ls-"));
  socket = join(dir, "s.sock");
  const binary = buildScheduler();
  if (binary === null) {
    served = "protocol server";
    server = await protocolServer(socket);
  } else {
    served = "mameko-local-scheduler";
    const lease = join(dir, "lease.json");
    writeFileSync(lease, JSON.stringify(LEASE));
    child = spawn(binary, ["--socket", socket, "--lease", lease], { stdio: "ignore" });
  }
  await accepting(socket);
  // A working tree with one tracked file, one untracked executable and one ignored file.
  const tree = join(dir, "tree");
  spawnSync("mkdir", ["-p", tree]);
  git(tree, "init", "-q", "-b", "main");
  git(tree, "remote", "add", "origin", "git@github.com:acme/widgets.git");
  writeFileSync(join(tree, "README.md"), "widgets\n");
  writeFileSync(join(tree, ".gitignore"), "dist/\n");
  git(tree, "add", ".");
  writeFileSync(join(tree, "build.sh"), "#!/bin/sh\n");
  chmodSync(join(tree, "build.sh"), 0o755);
  spawnSync("mkdir", ["-p", join(tree, "dist")]);
  writeFileSync(join(tree, "dist", "out.js"), "x");
  scheduler = socketScheduler(socket, {
    workingTree: gitWorkingTree(tree),
    ledger: fileLedger(join(dir, "state", "local-submissions.json")),
  });
}, 300_000);

afterAll(async () => {
  child?.kill();
  await new Promise<void>((resolve) =>
    server === undefined ? resolve() : server.close(() => resolve()),
  );
  rmSync(dir, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect));

describe("the local scheduler socket", () => {
  it("[FD-IFC-076] submit answers the local- ULID the scheduler generated with its queue position, and a matching submission attaches to that execution", async () => {
    const first = await Effect.runPromise(
      scheduler.submit({ run: "check", inputs: { b: 1, a: 2 }, class: "rehearsal" }),
    );
    expect(first.execution_id, served).toMatch(LOCAL_ID);
    expect(first).toEqual({
      execution_id: first.execution_id,
      status: "queued",
      queue_position: 0,
      verdict: null,
      reason: null,
      advisory: true,
    });
    // The same tree, run and inputs, with the inputs' keys in another order, attach to the live execution.
    const again = await Effect.runPromise(
      scheduler.submit({ run: "check", inputs: { a: 2, b: 1 }, class: "rehearsal" }),
    );
    expect(again).toMatchObject({
      execution_id: first.execution_id,
      status: "queued",
      queue_position: null,
    });
    const other = await Effect.runPromise(
      scheduler.submit({ run: "check", inputs: { a: 3 }, class: "rehearsal" }),
    );
    expect(other.execution_id).toMatch(LOCAL_ID);
    expect(other.execution_id).not.toBe(first.execution_id);
    expect(other.queue_position).toBe(1);

    expect(
      (await Effect.runPromise(scheduler.queue)).map((e) => [e.execution_id, e.status]),
    ).toEqual([
      [first.execution_id, "queued"],
      [other.execution_id, "queued"],
    ]);

    // Cancel detaches both of this device's submissions, and the execution stops when the last one leaves.
    expect(await Effect.runPromise(scheduler.cancel(first.execution_id))).toMatchObject({
      execution_id: first.execution_id,
      status: "done",
      verdict: "cancelled",
      advisory: true,
    });
    expect((await Effect.runPromise(scheduler.queue)).map((e) => e.execution_id)).toEqual([
      other.execution_id,
    ]);
    const unknown = await run(scheduler.cancel(first.execution_id));
    expect(unknown._tag === "Failure" && unknown.failure).toMatchObject({
      code: "not-found",
      exitCode: 2,
    });
  });

  it("[FD-IFC-076] lease status reports the capacity lease's slots, token allowance and offline flag", async () => {
    expect(await Effect.runPromise(scheduler.leaseStatus)).toEqual({
      state: "active",
      slots: { lean: 2 },
      remaining_token_allowance: 250_000,
      offline: false,
    });
  });

  it("[FD-IFC-076] a class the lease does not allow is rejected under the scheduler's code, and outcome and failure summary answer scheduler_protocol", async () => {
    const refused = await run(scheduler.submit({ run: "check", inputs: {}, class: "background" }));
    expect(refused._tag === "Failure" && refused.failure).toMatchObject({
      code: "class-not-allowed",
      exitCode: 2,
    });
    const outcome = await run(scheduler.outcome("local-01J00000000000000000000000", 0));
    expect(outcome._tag === "Failure" && outcome.failure).toMatchObject({
      code: "scheduler_protocol",
      exitCode: 5,
    });
    const summary = await run(scheduler.failureSummary("local-01J00000000000000000000000"));
    expect(summary._tag === "Failure" && summary.failure).toMatchObject({
      code: "scheduler_protocol",
    });
  });

  it("reads a working tree's tracked and admitted untracked files with their executable bits, and its GitHub scope", async () => {
    const tree = await Effect.runPromise(gitWorkingTree(join(dir, "tree")));
    expect(tree.scope).toBe("acme/widgets");
    expect(tree.files.map((f) => [f.path, f.executable]).sort()).toEqual([
      [".gitignore", false],
      ["README.md", false],
      ["build.sh", true],
    ]);
    expect(scopeOfRemote("https://github.com/acme/widgets")).toBe("acme/widgets");
    expect(scopeOfRemote("https://gitlab.com/acme/widgets.git")).toBeNull();
  });
});
