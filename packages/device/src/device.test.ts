import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { answerHello } from "@fractalboxdev/mameko-protocol";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { answerLine, hello, type ExtensionState } from "./extension.ts";
import { L1 } from "./l1.ts";
import { handleMessage, TOOLS } from "./mcp.ts";
import { cpuPriority } from "./priority.ts";
import { schedulerSocketLayer } from "./scheduler-socket.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const tempDir = async () => {
  const d = await mkdtemp(join(tmpdir(), "fd-device-"));
  dirs.push(d);
  return d;
};

describe("CPU priority", () => {
  it("[FD-EXEC-059] required at user-initiated, interactive at utility, batch and capacity leases at background", () => {
    const profile = buildProfile("production");
    const qos = (c: string) => cpuPriority(profile, c)?.["apple-container"];
    expect([qos("required"), qos("interactive"), qos("batch"), qos("capacity-lease")]).toEqual([
      "user-initiated",
      "utility",
      "background",
      "background",
    ]);
    expect(cpuPriority(profile, "release")).toBeNull();
    expect(cpuPriority(profile, "required")?.["oci-engine"]).toBe(1000);
  });
});

const NS_READ = "protected/o/r/device";
const NS_PR = "pr/o/r/7";

const state = async (): Promise<ExtensionState> => ({
  planeId: "plane-1",
  l1: new L1(await tempDir(), 1024),
  content: new Map(),
  readable: new Set(),
  writable: new Set(),
});

const send = (s: ExtensionState, message: Record<string, unknown>) =>
  answerLine(s, JSON.stringify(message));
const b64 = (t: string) => Buffer.from(t).toString("base64");

describe("device extension", () => {
  it("MAMEKO-EXEC-140 says hello naming the plane, the version and its operations, without a statement operation", () => {
    const h = hello("plane-1");
    expect(answerHello(h, { planeId: "plane-1", accepted: { min: 1, max: 1 } }).type).toBe(
      "extension.welcome",
    );
    expect(h.operations).not.toContain("statement");
  });

  it("[FD-EXEC-007] restores only from a namespace a lease handed to the extension may read", async () => {
    const s = await state();
    send(s, {
      type: "proxies",
      id: "p1",
      lease: { execution_id: "x1", cache_namespaces: { read: [NS_READ], write: NS_PR } },
    });
    expect(
      send(s, { type: "cache.put", id: "1", namespace: NS_PR, key: "k", bytes: b64("pr-bytes") })
        ?.type,
    ).toBe("cache.put.ok");
    // The protected namespace is readable but this lease may not write it.
    expect(
      send(s, { type: "cache.put", id: "2", namespace: NS_READ, key: "k", bytes: b64("x") })?.type,
    ).toBe("extension.error");
    s.l1.put(NS_READ, "k", new TextEncoder().encode("protected-bytes"));
    expect(send(s, { type: "cache.get", id: "3", namespace: NS_READ, key: "k" })).toMatchObject({
      type: "cache.get.ok",
      ref: "3",
      bytes: b64("protected-bytes"),
    });
    // The pull-request namespace holds bytes, but no lease reads it, so nothing restores from it.
    expect(send(s, { type: "cache.get", id: "4", namespace: NS_PR, key: "k" })).toMatchObject({
      bytes: null,
    });
    expect(send(s, { type: "cache.get", id: "5", namespace: "../etc", key: "k" })).toMatchObject({
      bytes: null,
    });
  });

  it("[FD-CACHE-009] [FD-CACHE-010] L1 evicts the least recently read entry first, and evict answers the bytes freed", async () => {
    const l1 = new L1(await tempDir(), 30);
    l1.put(NS_READ, "a", new Uint8Array(10));
    l1.put(NS_READ, "b", new Uint8Array(10));
    l1.get(NS_READ, "a");
    l1.put(NS_READ, "c", new Uint8Array(15));
    expect(l1.get(NS_READ, "b")).toBeNull();
    expect(l1.get(NS_READ, "a")).not.toBeNull();
    expect(l1.evict(12)).toBe(15);
    expect(l1.usedBytes).toBe(10);
  });

  it("holds LocalContent per tenant scope and answers malformed lines with extension.error", async () => {
    const s = await state();
    const put = send(s, {
      type: "content.put",
      id: "1",
      scope_id: "s1",
      bytes: b64("hi"),
    }) as unknown as { digest: string };
    expect(put.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      send(s, { type: "content.get", id: "2", scope_id: "s1", digest: put.digest }),
    ).toMatchObject({ bytes: b64("hi") });
    expect(
      send(s, { type: "content.get", id: "3", scope_id: "s2", digest: put.digest }),
    ).toMatchObject({ bytes: null });
    expect(answerLine(s, "not json")).toMatchObject({ type: "extension.error", code: "invalid" });
    expect(send(s, { type: "statement", id: "9", input: {} })).toMatchObject({
      code: "unsupported",
      ref: "9",
    });
  });

  it("MAMEKO-EXEC-140 the process answers over file descriptor 3", async () => {
    const [ours, theirs] = await socketPair();
    const main = fileURLToPath(new URL("./extension-main.ts", import.meta.url));
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", main, "plane-1", await tempDir()],
      {
        stdio: ["ignore", "inherit", "inherit", theirs],
      },
    );
    const lines = readLines(ours);
    expect(JSON.parse(await lines.next())).toMatchObject({
      type: "extension.hello",
      plane_id: "plane-1",
    });
    ours.write(
      `${JSON.stringify({ type: "content.put", id: "1", scope_id: "s", bytes: b64("x") })}\n`,
    );
    expect(JSON.parse(await lines.next())).toMatchObject({ type: "content.put.ok", ref: "1" });
    ours.end();
    await new Promise((ok) => child.on("exit", ok));
  }, 20_000);
});

/** A connected pair of sockets over a Unix socket in a temporary directory. */
const socketPair = async (): Promise<[net.Socket, net.Socket]> => {
  const path = join(await tempDir(), "pair.sock");
  return new Promise((ok) => {
    const server = net.createServer((accepted) => {
      server.close();
      ok([client, accepted]);
    });
    let client: net.Socket;
    server.listen(path, () => {
      client = net.createConnection(path);
    });
  });
};

const readLines = (socket: net.Socket) => {
  let buffer = "";
  const waiting: ((line: string) => void)[] = [];
  const ready: string[] = [];
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const w = waiting.shift();
      if (w === undefined) ready.push(line);
      else w(line);
    }
  });
  return {
    next: () =>
      new Promise<string>((ok) => {
        const line = ready.shift();
        if (line === undefined) waiting.push(ok);
        else ok(line);
      }),
  };
};

describe("MCP server", () => {
  const fakeScheduler = async () => {
    const path = join(await tempDir(), "ls.sock");
    const received: unknown[] = [];
    const server = net.createServer((conn) => {
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        const request = JSON.parse(buffer.slice(0, end)) as { op: string };
        received.push(request);
        conn.end(
          `${JSON.stringify(
            request.op === "cancel"
              ? { ok: false, error: { code: "not_found", message: "no such execution" } }
              : { ok: true, result: { op: request.op } },
          )}\n`,
        );
      });
    });
    await new Promise<void>((ok) => server.listen(path, ok));
    return { path, received, close: () => server.close() };
  };

  const call = (path: string, name: string, args: Record<string, unknown> = {}) =>
    Effect.runPromise(
      handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }).pipe(Effect.provide(schedulerSocketLayer(path))),
    ) as Promise<{ result: { structuredContent: unknown; isError: boolean } }>;

  it("[FD-LOCAL-038] serves rehearse, get_verdict, get_failure_summary, cancel and lease_status, each over the scheduler socket", async () => {
    const scheduler = await fakeScheduler();
    const list = (await Effect.runPromise(
      handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }).pipe(
        Effect.provide(schedulerSocketLayer(scheduler.path)),
      ),
    )) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual([
      "rehearse",
      "get_verdict",
      "get_failure_summary",
      "cancel",
      "lease_status",
    ]);
    expect(TOOLS.map((t) => t.op)).toEqual([
      "submit",
      "outcome",
      "failure_summary",
      "cancel",
      "lease_status",
    ]);

    expect(
      (await call(scheduler.path, "rehearse", { run: "check" })).result.structuredContent,
    ).toEqual({ op: "submit" });
    expect(scheduler.received[0]).toEqual({ op: "submit", class: "rehearsal", run: "check" });
    expect(
      (await call(scheduler.path, "get_verdict", { execution_id: "local-1" })).result
        .structuredContent,
    ).toEqual({
      op: "outcome",
    });
    expect(
      (await call(scheduler.path, "cancel", { execution_id: "local-1" })).result,
    ).toMatchObject({
      isError: true,
      structuredContent: { error: "not_found" },
    });
    scheduler.close();
  });

  it("[FD-LOCAL-038] answers scheduler_unreachable when the socket is absent", async () => {
    const result = await call(join(await tempDir(), "absent.sock"), "lease_status");
    expect(result.result).toMatchObject({
      isError: true,
      structuredContent: { error: "scheduler_unreachable" },
    });
  });

  it("[FD-IFC-078] refuses a wait over 600 s on rehearse or 60 s on get_verdict with invalid_wait", async () => {
    const path = join(await tempDir(), "absent.sock");
    expect(
      (await call(path, "rehearse", { run: "check", wait_seconds: 601 })).result.structuredContent,
    ).toMatchObject({
      error: "invalid_wait",
    });
    expect(
      (await call(path, "get_verdict", { execution_id: "x", wait_seconds: 61 })).result
        .structuredContent,
    ).toMatchObject({
      error: "invalid_wait",
    });
  });
});
