import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { es256Sign, signedBody, type Manifest } from "@fractalboxdev/flare-dispatch-cache";
import {
  memoryDisk,
  nodeDisk,
  openL1,
  type L1Disk,
  type L2Client,
  type L2Entry,
} from "@fractalboxdev/flare-dispatch-cache/device";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { answerHello } from "@fractalboxdev/mameko-protocol";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { absentL2, answerLine, hello, type ExtensionState } from "./extension.ts";
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
const NS_EXEC = "exec/o/r/01JDZ8Q6V3M2K9T4WXYZ5ABCDE";
const key = (n: number) => n.toString(16).padStart(64, "0");
const utf8 = (t: string) => new TextEncoder().encode(t);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const signingKey = async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { privateKey: pair.privateKey, keys: { controlPlane: publicJwk, device: () => null } };
};

/** An L2 entry a cloud executor committed: one object and its control-plane-signed manifest. */
const l2Entry = async (
  privateKey: CryptoKey,
  namespace: string,
  k: string,
  body: Uint8Array,
): Promise<L2Entry> => {
  const path = `cache/${namespace}/${k}/e.1/blob`;
  const unsigned = {
    key: k,
    namespace,
    tier: "protected-device" as const,
    writer: { executor_id: "cf-1", executor_kind: "cloudflare", execution_id: "e", epoch: 1 },
    objects: [{ path, size: body.byteLength, sha256: sha256(body) }],
    created_at: 0,
  };
  const manifest: Manifest = {
    ...unsigned,
    signature: {
      alg: "ES256",
      key_id: "control-plane",
      value: await es256Sign(privateKey, signedBody(unsigned)),
    },
  };
  return { manifest, objects: new Map([[path, body]]) };
};

/** L2 in memory, recording every fetch and upload in `events` beside the disk writes. */
const memoryL2 = (events: string[]) => {
  const entries = new Map<string, L2Entry>();
  const client: L2Client = {
    fetch: async (ns, k) => {
      events.push(`l2.fetch ${ns}/${k}`);
      return entries.get(`${ns}/${k}`) ?? null;
    },
    upload: async (ns, k) => void events.push(`l2.upload ${ns}/${k}`),
  };
  return { entries, client };
};

const recordingDisk = (events: string[]): L1Disk & { readonly files: Map<string, Uint8Array> } => {
  const disk = memoryDisk(1_000_000);
  return {
    ...disk,
    write: async (p, b) => {
      events.push(`l1.write ${p}`);
      await disk.write(p, b);
    },
  };
};

const state = async (options: Partial<Parameters<typeof openL1>[0]> = {}): Promise<ExtensionState> => ({
  planeId: "plane-1",
  l1: await openL1({
    disk: nodeDisk(await tempDir()),
    l2: absentL2,
    keys: (await signingKey()).keys,
    ...options,
  }),
  content: new Map(),
  readable: new Set(),
  writable: new Set(),
});

const send = (s: ExtensionState, message: Record<string, unknown>) =>
  Effect.runPromise(answerLine(s, JSON.stringify(message)));
const b64 = (t: string) => Buffer.from(t).toString("base64");
const lease = (read: string[], write: string | null) => ({
  type: "proxies",
  id: "p1",
  lease: { execution_id: "x1", cache_namespaces: { read, write } },
});

describe("device extension", () => {
  it("MAMEKO-EXEC-140 says hello naming the plane, the version and its operations, with the statement operation", () => {
    const h = hello("plane-1");
    expect(answerHello(h, { planeId: "plane-1", accepted: { min: 1, max: 1 } }).type).toBe(
      "extension.welcome",
    );
    expect(h.operations).toContain("statement");
  });

  it("[FD-EXEC-007] restores only from a namespace a lease handed to the extension may read", async () => {
    const s = await state();
    await send(s, lease([NS_READ], NS_PR));
    expect(
      (
        await send(s, {
          type: "cache.put",
          id: "1",
          namespace: NS_PR,
          key: key(1),
          bytes: b64("pr-bytes"),
        })
      )?.type,
    ).toBe("cache.put.ok");
    // The protected namespace is readable but this lease may not write it.
    expect(
      (await send(s, { type: "cache.put", id: "2", namespace: NS_READ, key: key(1), bytes: b64("x") }))
        ?.type,
    ).toBe("extension.error");
    await Effect.runPromise(s.l1.put(NS_READ, key(1), utf8("protected-bytes")));
    expect(await send(s, { type: "cache.get", id: "3", namespace: NS_READ, key: key(1) })).toMatchObject({
      type: "cache.get.ok",
      ref: "3",
      bytes: b64("protected-bytes"),
    });
    // The pull-request namespace holds bytes, but no lease reads it, so nothing restores from it.
    expect(await send(s, { type: "cache.get", id: "4", namespace: NS_PR, key: key(1) })).toMatchObject({
      bytes: null,
    });
    expect(await send(s, { type: "cache.get", id: "5", namespace: "../etc", key: key(1) })).toMatchObject({
      bytes: null,
    });
  });

  it("[FD-CACHE-006] a cache.get that L1 lacks reads through to L2 and places the entry in L1 only once every digest verifies", async () => {
    const events: string[] = [];
    const { privateKey, keys } = await signingKey();
    const l2 = memoryL2(events);
    l2.entries.set(`${NS_READ}/${key(1)}`, await l2Entry(privateKey, NS_READ, key(1), utf8("good")));
    const tampered = await l2Entry(privateKey, NS_READ, key(2), utf8("good"));
    l2.entries.set(`${NS_READ}/${key(2)}`, {
      ...tampered,
      objects: new Map([[tampered.manifest.objects[0]!.path, utf8("evil")]]),
    });
    const disk = recordingDisk(events);
    const s = await state({ disk, l2: l2.client, keys });
    await send(s, lease([NS_READ, NS_PR], null));

    expect(await send(s, { type: "cache.get", id: "1", namespace: NS_READ, key: key(1) })).toMatchObject({
      type: "cache.get.ok",
      bytes: b64("good"),
    });
    // The bytes go to L1 first, then the manifest they verified under, which a peer verifies in turn (FD-CACHE-014).
    expect(events).toEqual([
      `l2.fetch ${NS_READ}/${key(1)}`,
      `l1.write ${NS_READ}/${key(1)}`,
      `l1.write ${NS_READ}/${key(1)}.manifest.json`,
    ]);
    // The entry is in L1 now: a second read is answered without L2.
    events.length = 0;
    expect(await send(s, { type: "cache.get", id: "2", namespace: NS_READ, key: key(1) })).toMatchObject({
      bytes: b64("good"),
    });
    expect(events).toEqual([]);
    // An object whose bytes do not hash to the manifest's digest is a miss and never reaches L1.
    expect(await send(s, { type: "cache.get", id: "3", namespace: NS_READ, key: key(2) })).toMatchObject({
      bytes: null,
    });
    expect(disk.files.has(`${NS_READ}/${key(2)}`)).toBe(false);
    // L2 holds no entry under this namespace and key: a miss.
    expect(await send(s, { type: "cache.get", id: "4", namespace: NS_PR, key: key(1) })).toMatchObject({
      bytes: null,
    });
  });

  it("[FD-CACHE-007] a cache.put writes the entry to L1 and then uploads it to L2, and a failed upload leaves the put answered", async () => {
    const events: string[] = [];
    const disk = recordingDisk(events);
    const l2 = memoryL2(events);
    const s = await state({ disk, l2: l2.client });
    await send(s, lease([NS_EXEC], NS_EXEC));
    const reply = await send(s, {
      type: "cache.put",
      id: "1",
      namespace: NS_EXEC,
      key: key(1),
      bytes: b64("built"),
    });
    expect(reply).toMatchObject({ type: "cache.put.ok", digest: `sha256:${sha256(utf8("built"))}` });
    expect(events).toEqual([`l1.write ${NS_EXEC}/${key(1)}`, `l2.upload ${NS_EXEC}/${key(1)}`]);

    const failing = await state({
      disk,
      l2: {
        ...l2.client,
        upload: async () => {
          throw new Error("507");
        },
      },
    });
    await send(failing, lease([NS_EXEC], NS_EXEC));
    expect(
      await send(failing, { type: "cache.put", id: "2", namespace: NS_EXEC, key: key(2), bytes: b64("y") }),
    ).toMatchObject({ type: "cache.put.ok" });
    expect(disk.files.has(`${NS_EXEC}/${key(2)}`)).toBe(true);
    // A key that is not a cache key names no L2 entry and is refused.
    expect(
      await send(s, { type: "cache.put", id: "3", namespace: NS_EXEC, key: "k", bytes: b64("z") }),
    ).toMatchObject({ type: "extension.error", code: "invalid" });
  });

  it("[FD-CACHE-009] [FD-CACHE-010] L1 evicts the least recently read entry first, and evict answers the bytes freed", async () => {
    let t = 0;
    const disk = memoryDisk(150);
    const s = await state({ disk, now: () => ++t });
    await send(s, lease([NS_READ], NS_READ));
    const put = (k: number, n: number) =>
      send(s, {
        type: "cache.put",
        id: `p${k}`,
        namespace: NS_READ,
        key: key(k),
        bytes: Buffer.from(new Uint8Array(n)).toString("base64"),
      });
    const get = (k: number) => send(s, { type: "cache.get", id: `g${k}`, namespace: NS_READ, key: key(k) });
    // The cap is 20% of the 150 free bytes measured at start: 30.
    await put(1, 10);
    await put(2, 10);
    await get(1);
    await put(3, 15);
    expect(await get(2)).toMatchObject({ bytes: null });
    expect((await get(1))?.bytes).not.toBeNull();
    expect(await send(s, { type: "cache.evict", id: "e", target_bytes: 12 })).toMatchObject({
      type: "cache.evict.ok",
      freed_bytes: 15,
    });
    expect([...disk.files.keys()]).toEqual([`${NS_READ}/${key(1)}`]);
  });

  it("holds LocalContent per tenant scope and answers malformed lines with extension.error", async () => {
    const s = await state();
    const put = (await send(s, {
      type: "content.put",
      id: "1",
      scope_id: "s1",
      bytes: b64("hi"),
    })) as unknown as { digest: string };
    expect(put.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      await send(s, { type: "content.get", id: "2", scope_id: "s1", digest: put.digest }),
    ).toMatchObject({ bytes: b64("hi") });
    expect(
      await send(s, { type: "content.get", id: "3", scope_id: "s2", digest: put.digest }),
    ).toMatchObject({ bytes: null });
    expect(await Effect.runPromise(answerLine(s, "not json"))).toMatchObject({
      type: "extension.error",
      code: "invalid",
    });
    expect(await send(s, { type: "statement", id: "9", input: {} })).toMatchObject({
      type: "extension.error",
      code: "invalid",
      ref: "9",
    });
  });

  it("MAMEKO-EXEC-140 the process answers over file descriptor 3", async () => {
    const [ours, theirs] = await socketPair();
    const main = fileURLToPath(new URL("./extension-main.ts", import.meta.url).href);
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
    // L1 on the directory named: a put under the lease's namespace is read back.
    for (const m of [
      lease([NS_READ], NS_READ),
      { type: "cache.put", id: "2", namespace: NS_READ, key: key(1), bytes: b64("on-disk") },
      { type: "cache.get", id: "3", namespace: NS_READ, key: key(1) },
    ])
      ours.write(`${JSON.stringify(m)}\n`);
    expect(JSON.parse(await lines.next())).toMatchObject({ type: "proxies.ok" });
    expect(JSON.parse(await lines.next())).toMatchObject({ type: "cache.put.ok", ref: "2" });
    expect(JSON.parse(await lines.next())).toMatchObject({
      type: "cache.get.ok",
      ref: "3",
      bytes: b64("on-disk"),
    });
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
