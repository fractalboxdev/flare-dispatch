// FlareDispatch's device extension process as mameko's device executor reaches it: started with its end of a
// socketpair as file descriptor 3 (MAMEKO-EXEC-155), greeted through mameko's `answerHello`, and driven only with
// messages of mameko's extension schema, each reply decoded by that schema. L1 lives on a temporary directory the
// suite reads back, so the one-directory-per-namespace layout is checked on disk.
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerHello, EXTENSION_FD, ExtensionMessage } from "@fractalboxdev/mameko-protocol";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

const MAIN = join(import.meta.dirname, "../../device/src/extension-main.ts");
const PLANE = "plane-conf";

const NS_DEVICE = "protected/o/r/device";
const NS_PR = "pr/o/r/7";
const NS_EXEC = "exec/o/r/01JDZ8Q6V3M2K9T4WXYZ5ABCDE";
/** A protected namespace without its `cloud` or `device` lane: a path L1 accepts, but no cache namespace form. */
const NS_MALFORMED = "protected/o/r";
const key = (n: number) => n.toString(16).padStart(64, "0");
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const decodeMessage = Schema.decodeUnknownSync(ExtensionMessage);

type Message = typeof ExtensionMessage.Type;

/** A lease as the device executor hands it to the extension in a `proxies` request. */
const proxies = (id: string, read: readonly string[], write: string | null): Message => ({
  type: "proxies",
  id,
  lease: { execution_id: `x-${id}`, cache_namespaces: { read, write } },
});

interface Extension {
  readonly root: string;
  /** The operations the extension's `extension.hello` names. */
  readonly operations: readonly string[];
  /** Sends one request and returns its reply, decoded by mameko's extension schema. */
  readonly request: (m: Message) => Promise<Message & { readonly ref?: string }>;
}

const running: { child: ChildProcess; socket: Socket; root: string }[] = [];

afterEach(async () => {
  for (const { child, socket, root } of running.splice(0)) {
    socket.end();
    // A child killed by a signal keeps `exitCode` null after `exit` has fired, so `signalCode` is checked too.
    if (child.exitCode === null && child.signalCode === null)
      await new Promise((ok) => child.once("exit", ok));
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Starts `fd-device-extension` on a fresh L1 directory, optionally seeded with entries already on disk, reads its
 * `extension.hello` and answers it with mameko's `answerHello`.
 */
const start = async (
  seed: readonly { namespace: string; key: string; text: string }[] = [],
): Promise<Extension> => {
  const root = mkdtempSync(join(tmpdir(), "fd-device-extension-conf-"));
  for (const s of seed) {
    mkdirSync(join(root, s.namespace), { recursive: true });
    writeFileSync(join(root, s.namespace, s.key), s.text);
  }
  // A `pipe` beyond stdio is a socketpair; the child inherits its end as file descriptor 3.
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", MAIN, PLANE, root],
    { stdio: ["ignore", "ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (c) => (stderr += c));
  const socket = child.stdio[EXTENSION_FD] as Socket;
  running.push({ child, socket, root });

  let buffer = "";
  const waiting: ((line: string) => void)[] = [];
  const ready: string[] = [];
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const w = waiting.shift();
      if (w === undefined) ready.push(line);
      else w(line);
    }
  });
  const next = () =>
    new Promise<Message & { readonly ref?: string }>((ok, fail) => {
      const timer = setTimeout(
        () => fail(new Error(`no line from the extension; stderr: ${stderr}`)),
        15_000,
      );
      const take = (line: string) => {
        clearTimeout(timer);
        // Every line the extension writes is one message of mameko's extension schema (MAMEKO-EXEC-155).
        ok(decodeMessage(JSON.parse(line)));
      };
      const line = ready.shift();
      if (line === undefined) waiting.push(take);
      else take(line);
    });
  const send = (m: unknown) => socket.write(`${JSON.stringify(m)}\n`);

  const hello = await next();
  if (hello.type !== "extension.hello") throw new Error(`first line is ${hello.type}`);
  expect(hello.plane_id).toBe(PLANE);
  const welcome = answerHello(hello, { planeId: PLANE, accepted: { min: 1, max: 1 } });
  expect(welcome.type).toBe("extension.welcome");
  send(welcome);

  return {
    root,
    operations: hello.operations,
    request: async (m) => {
      send(m);
      const reply = await next();
      expect(reply.ref).toBe(m.id);
      return reply;
    },
  };
};

const onDisk = (root: string, namespace: string, k: string) => {
  const path = join(root, namespace, k);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
};

describe("device extension over mameko's extension interface", { timeout: 60_000 }, () => {
  it("[FD-CACHE-004] keeps L1 on local disk in one directory per namespace and serves cache.get, cache.put and cache.evict", async () => {
    const ext = await start();
    expect(await ext.request(proxies("p1", [NS_DEVICE, NS_PR], NS_PR))).toMatchObject({
      type: "proxies.ok",
      proxies: [],
    });
    expect(await ext.request(proxies("p2", [NS_EXEC], NS_EXEC))).toMatchObject({
      type: "proxies.ok",
    });

    // One key under two namespaces is two entries, each in its namespace's directory.
    expect(
      await ext.request({
        type: "cache.put",
        id: "put-pr",
        namespace: NS_PR,
        key: key(1),
        bytes: b64("pr-entry"),
      }),
    ).toEqual({
      type: "cache.put.ok",
      id: "cache.put.ok-put-pr",
      ref: "put-pr",
      digest: `sha256:${sha256("pr-entry")}`,
    });
    expect(
      await ext.request({
        type: "cache.put",
        id: "put-exec",
        namespace: NS_EXEC,
        key: key(1),
        bytes: b64("exec"),
      }),
    ).toMatchObject({ type: "cache.put.ok", digest: `sha256:${sha256("exec")}` });
    expect(onDisk(ext.root, NS_PR, key(1))).toBe("pr-entry");
    expect(onDisk(ext.root, NS_EXEC, key(1))).toBe("exec");

    expect(
      await ext.request({ type: "cache.get", id: "get-exec", namespace: NS_EXEC, key: key(1) }),
    ).toMatchObject({ type: "cache.get.ok", bytes: b64("exec") });
    expect(
      await ext.request({ type: "cache.get", id: "get-pr", namespace: NS_PR, key: key(1) }),
    ).toMatchObject({ type: "cache.get.ok", bytes: b64("pr-entry") });
    // A key L1 lacks, with no L2 transport, is a miss.
    expect(
      await ext.request({ type: "cache.get", id: "get-miss", namespace: NS_PR, key: key(2) }),
    ).toMatchObject({ type: "cache.get.ok", bytes: null });

    // The exec entry was written last but read first, so it is the least recently read and leaves first.
    expect(await ext.request({ type: "cache.evict", id: "evict-1", target_bytes: 1 })).toEqual({
      type: "cache.evict.ok",
      id: "cache.evict.ok-evict-1",
      ref: "evict-1",
      freed_bytes: "exec".length,
    });
    expect(onDisk(ext.root, NS_EXEC, key(1))).toBeNull();
    expect(onDisk(ext.root, NS_PR, key(1))).toBe("pr-entry");
    expect(
      await ext.request({ type: "cache.get", id: "get-evicted", namespace: NS_EXEC, key: key(1) }),
    ).toMatchObject({ type: "cache.get.ok", bytes: null });

    expect(
      await ext.request({ type: "cache.evict", id: "evict-all", target_bytes: 1_000_000 }),
    ).toMatchObject({ type: "cache.evict.ok", freed_bytes: "pr-entry".length });
    expect(onDisk(ext.root, NS_PR, key(1))).toBeNull();
  });

  it("[FD-CACHE-004] serves the cache operations it names in its hello and answers a put outside every lease with extension.error", async () => {
    const ext = await start();
    await ext.request(proxies("p1", [NS_DEVICE], null));
    // A readable namespace no lease may write takes no put, and nothing is written to its directory.
    expect(
      await ext.request({
        type: "cache.put",
        id: "put-ro",
        namespace: NS_DEVICE,
        key: key(3),
        bytes: b64("x"),
      }),
    ).toMatchObject({ type: "extension.error", ref: "put-ro", code: "invalid" });
    expect(onDisk(ext.root, NS_DEVICE, key(3))).toBeNull();
    expect(ext.operations).toEqual(
      expect.arrayContaining(["cache.get", "cache.put", "cache.evict"]),
    );
  });

  // mameko starts one extension per plane (MAMEKO-EXEC-131) and its `cache.get` names no execution, so the extension
  // scopes reads to the leases handed to its plane, not to one execution. This suite pins that per-plane half only.
  it("[FD-EXEC-007] cache.get answers null for a namespace no lease handed to this plane's extension names as readable, though its directory holds the entry", async () => {
    const ext = await start([
      { namespace: NS_DEVICE, key: key(1), text: "protected-entry" },
      { namespace: NS_PR, key: key(1), text: "other-pr-entry" },
      // A file at a path a malformed namespace name reaches, which L1 itself indexes as an entry.
      { namespace: NS_MALFORMED, key: key(1), text: "malformed-entry" },
    ]);
    expect(await ext.request(proxies("p1", [NS_DEVICE], NS_EXEC))).toMatchObject({
      type: "proxies.ok",
    });

    expect(
      await ext.request({ type: "cache.get", id: "get-read", namespace: NS_DEVICE, key: key(1) }),
    ).toMatchObject({ type: "cache.get.ok", bytes: b64("protected-entry") });
    // The pull-request namespace's directory holds the key, but no lease names it as readable.
    expect(
      await ext.request({ type: "cache.get", id: "get-pr", namespace: NS_PR, key: key(1) }),
    ).toMatchObject({ type: "cache.get.ok", bytes: null });
    // A namespace the lease may write but not read restores nothing either.
    expect(
      await ext.request({
        type: "cache.put",
        id: "put-exec",
        namespace: NS_EXEC,
        key: key(2),
        bytes: b64("w"),
      }),
    ).toMatchObject({ type: "cache.put.ok" });
    expect(onDisk(ext.root, NS_EXEC, key(2))).toBe("w");
    expect(
      await ext.request({ type: "cache.get", id: "get-exec", namespace: NS_EXEC, key: key(2) }),
    ).toMatchObject({ type: "cache.get.ok", bytes: null });
    // A name outside the cache namespace forms is never read, even when a lease names it as readable and L1 holds
    // an entry at the path it reaches.
    await ext.request(proxies("p-bad", [NS_MALFORMED], null));
    expect(
      await ext.request({ type: "cache.get", id: "get-bad", namespace: NS_MALFORMED, key: key(1) }),
    ).toMatchObject({ type: "cache.get.ok", bytes: null });
  });
});
