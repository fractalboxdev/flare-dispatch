// The compile cache end to end on one machine: a device claims a pull request execution's lease from the deployed
// Worker, takes the compile-cache endpoint and token from the lease's upload grant, and builds a small Rust crate twice
// through a real sccache client wrapped by `compileCacheCommand`. sccache's WebDAV backend reaches the Worker's
// compile-cache route over HTTP through the stack's front, which streams each body and records each request; the
// second build, after `cargo clean`, reads what the first wrote.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPILE_CACHE_PREFIX, compileCacheCommand } from "@fractalboxdev/flare-dispatch-cache";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, hello, newDevice, OPERATOR, registration, type Socket } from "../support.ts";
import {
  PLANE_ID,
  REPOSITORY,
  startStack,
  WEBHOOK_SECRET,
  type Stack,
  type StackRequest,
} from "./stack.ts";

const CRATE = join(import.meta.dirname, "fixtures/crate");
const ROUTE = "/v1/compile-cache";
/** The recorded pull request's namespace, which its execution writes and reads first (FD-CACHE-019). */
const PR_NAMESPACE = `pr/${REPOSITORY}/7`;
const MiB = 1024 * 1024;

interface Grant {
  readonly cache_namespaces: { readonly read: readonly string[]; readonly write: string | null };
  readonly upload_grant: {
    readonly compile_cache: { readonly endpoint: string; readonly token: string } | null;
  };
}

interface Build {
  readonly code: number | null;
  readonly output: string;
  /** The requests sccache sent the compile-cache route during this build. */
  readonly requests: readonly StackRequest[];
  /** `sccache --show-stats` as the wrapper printed it. */
  readonly stats: Readonly<Record<string, number>>;
  /** What cargo wrote under `target/debug/incremental`. */
  readonly incremental: readonly string[];
}

let stack: Stack;
let device: Socket;
let grant: Grant;
let work: string;
let rustc: { readonly release: string; readonly host: string };
let first: Build;
let second: Build;

/** A free local port for the suite's own sccache server, so no other sccache server answers its client. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

/** The counters of `sccache --show-stats`, by label. */
const statsOf = (output: string): Record<string, number> => {
  const at = output.indexOf("--- sccache --show-stats ---");
  const stats: Record<string, number> = {};
  if (at < 0) return stats;
  for (const line of output.slice(at).split("\n")) {
    const m = /^([A-Za-z][A-Za-z ()]*?)\s{2,}(\d+)$/.exec(line.trim());
    if (m !== null) stats[m[1]!] = Number(m[2]);
  }
  return stats;
};

/**
 * The process environment without anything that steers cargo, rustc or sccache from outside the suite, so the wrapper
 * alone sets `RUSTC_WRAPPER`, `CARGO_INCREMENTAL` and the key prefix.
 */
const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !k.startsWith("SCCACHE_") &&
        !k.startsWith("CARGO_") &&
        k !== "RUSTC_WRAPPER" &&
        k !== "RUSTC_WORKSPACE_WRAPPER" &&
        k !== "RUSTFLAGS",
    ),
  ) as Record<string, string>;

/** `cargo build` of the fixture crate inside `compileCacheCommand`, with the grant's endpoint and token. */
const build = async (port: number): Promise<Build> => {
  const access = grant.upload_grant.compile_cache!;
  const before = stack.requests.length;
  const script = compileCacheCommand("cargo build --offline --quiet", REPOSITORY);
  if (script === undefined) throw new Error("no compile-cache wrapper for the repository");
  const { code, output } = await new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", script], {
        cwd: work,
        env: {
          ...cleanEnv(),
          SCCACHE_WEBDAV_ENDPOINT: access.endpoint,
          SCCACHE_WEBDAV_TOKEN: access.token,
          SCCACHE_SERVER_PORT: String(port),
          SCCACHE_CONF: join(work, "..", "sccache.toml"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (out += c.toString("utf8")));
      child.on("error", reject);
      child.on("close", (c) => resolve({ code: c, output: out }));
    },
  );
  const requests = stack.requests.slice(before).filter((r) => r.path.startsWith(`${ROUTE}/`));
  const incrementalDir = join(work, "target/debug/incremental");
  return {
    code,
    output,
    requests,
    stats: statsOf(output),
    incremental: existsSync(incrementalDir) ? readdirSync(incrementalDir) : [],
  };
};

const bucket = () => stack.mf.getR2Bucket("CACHE");

/** Every compile-cache object key under the pull request's namespace. */
const storedKeys = async () =>
  (await (await bucket()).list({ prefix: `${COMPILE_CACHE_PREFIX}${PR_NAMESPACE}/` })).objects.map(
    (o) => o.key,
  );

/** One request to the compile-cache route at `key` below the repository, as sccache's client sends it. */
const route = async (
  method: string,
  key: string,
  init: { headers?: Record<string, string>; body?: BodyInit; token?: string | null } = {},
) => {
  const token = init.token === undefined ? grant.upload_grant.compile_cache!.token : init.token;
  return fetch(`${grant.upload_grant.compile_cache!.endpoint}/${key}`, {
    method,
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body, duplex: "half" }),
  } as RequestInit);
};

beforeAll(async () => {
  stack = await startStack({ publicOrigin: true });
  const { identity, keys } = await newDevice();
  const enrolled = await fetch(`${stack.url}/v1/executors/register`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await stack.access(OPERATOR)) },
    body: JSON.stringify(registration("cc-device", identity)),
  });
  expect(enrolled.status).toBe(201);
  device = await connect(stack.mf, "cc-device", keys, PLANE_ID);
  device.send(hello("cc-device", PLANE_ID));
  await device.next("session.welcome");

  const delivery = stack.github.delivery(
    "pull_request",
    "pull_request.opened.json",
    WEBHOOK_SECRET,
  );
  const delivered = await fetch(`${stack.url}/v1/webhooks/github`, {
    method: "POST",
    headers: delivery.headers,
    body: delivery.body,
  });
  expect(delivered.status).toBe(202);
  const { executions } = (await delivered.json()) as { executions: string[] };
  expect(executions).toHaveLength(1);
  // The device holds the lease, unsettled, for the whole suite: the token is bound to this epoch.
  device.send({
    type: "exec.claim",
    id: "c1",
    free: { release: 1, required: 1, interactive: 1, batch: 1 },
  });
  const lease = await device.next("exec.lease");
  expect(lease["execution_id"]).toBe(executions[0]);
  grant = lease as unknown as Grant;

  const vv = spawnSync("rustc", ["-vV"], { encoding: "utf8", env: cleanEnv() }).stdout;
  rustc = {
    release: /^release: (.+)$/m.exec(vv)?.[1] ?? "",
    host: /^host: (.+)$/m.exec(vv)?.[1] ?? "",
  };
  const root = mkdtempSync(join(tmpdir(), "fd-compile-cache-"));
  writeFileSync(join(root, "sccache.toml"), "");
  work = join(root, "crate");
  cpSync(CRATE, work, { recursive: true });
  const port = await freePort();
  first = await build(port);
  spawnSync("cargo", ["clean", "--quiet"], { cwd: work, env: cleanEnv() });
  second = await build(port);
}, 600_000);

afterAll(async () => {
  if (work !== undefined) rmSync(join(work, ".."), { recursive: true, force: true });
  await stack?.close();
});

describe("the compile cache through a real sccache client", () => {
  it("[FD-CACHE-037] the wrapper builds through sccache with CARGO_INCREMENTAL=0 under the <repo>/<rustc>/<target> prefix", async () => {
    // The lease's grant names the route at the Worker's public origin and carries a token for this repository.
    expect(grant.cache_namespaces.write).toBe(PR_NAMESPACE);
    expect(grant.upload_grant.compile_cache).toEqual({
      endpoint: `${stack.url}${ROUTE}/${REPOSITORY}`,
      token: expect.any(String),
    });
    expect(rustc.release).not.toBe("");
    expect(rustc.host).not.toBe("");

    // RUSTC_WRAPPER=sccache: cargo's rustc invocations reached the sccache server, and the library compile missed.
    expect(first.code, first.output).toBe(0);
    expect(first.stats["Compile requests"]).toBeGreaterThan(0);
    expect(first.stats["Cache misses"]).toBe(1);
    expect(first.stats["Cache write errors"]).toBe(0);
    // CARGO_INCREMENTAL=0: cargo kept no incremental session, which sccache would refuse to cache.
    expect(first.incremental).toEqual([]);

    // The second build, after `cargo clean`, takes the library from the cache and links a working binary.
    expect(second.code, second.output).toBe(0);
    expect(second.stats["Cache hits"]).toBe(1);
    expect(second.stats["Cache misses"]).toBe(0);
    const ran = spawnSync(join(work, "target/debug/fd-compile-cache-fixture"), {
      encoding: "utf8",
    });
    expect(ran.stdout.trim()).toBe("385");

    // Every key sccache addressed, and every object it wrote, sits under the prefix.
    const prefix = `${REPOSITORY}/${rustc.release}/${rustc.host}/`;
    const sent = [...first.requests, ...second.requests];
    expect(sent.length).toBeGreaterThan(0);
    for (const r of sent) expect(r.path.startsWith(`${ROUTE}/${REPOSITORY}/${prefix}`)).toBe(true);
    const stored = await storedKeys();
    expect(stored.filter((k) => !k.endsWith("/.sccache_check")).length).toBeGreaterThan(0);
    for (const k of stored)
      expect(k.startsWith(`${COMPILE_CACHE_PREFIX}${PR_NAMESPACE}/${prefix}`)).toBe(true);
  });

  it("[FD-CACHE-056] serves GET, HEAD, PUT, PROPFIND Depth 0 and MKCOL to a holder of the compile-cache token", async () => {
    // sccache's own traffic: a GET that misses, PROPFIND Depth 0 of the entry's parent, then the PUT.
    const methods = (b: Build) => new Set(b.requests.map((r) => r.method));
    expect(methods(first)).toEqual(new Set(["GET", "PROPFIND", "PUT"]));
    for (const r of first.requests.filter((q) => q.method === "PROPFIND"))
      expect(r.headers["depth"]).toBe("0");
    for (const r of first.requests)
      expect(r.headers["authorization"]).toBe(`Bearer ${grant.upload_grant.compile_cache!.token}`);
    const put = first.requests.filter(
      (r) => r.method === "PUT" && !r.path.endsWith("/.sccache_check"),
    );
    expect(put).toHaveLength(1);
    // The second build read the object the first wrote, from the key it was written at.
    expect(second.requests.filter((r) => r.method === "GET").map((r) => r.path)).toContain(
      put[0]!.path,
    );

    // The same object over the methods sccache did not need this time.
    const key = put[0]!.path.slice(`${ROUTE}/${REPOSITORY}/`.length);
    const stored = await (await bucket()).head(`${COMPILE_CACHE_PREFIX}${PR_NAMESPACE}/${key}`);
    expect(stored).not.toBeNull();
    const head = await route("HEAD", key);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(stored!.size));
    const got = await route("GET", key);
    expect(got.status).toBe(200);
    expect((await got.arrayBuffer()).byteLength).toBe(stored!.size);
    const stat = await route("PROPFIND", key, { headers: { depth: "0" } });
    expect(stat.status).toBe(207);
    expect(await stat.text()).toContain(`<D:getcontentlength>${stored!.size}</D:getcontentlength>`);
    const dir = key.slice(0, key.lastIndexOf("/") + 1);
    expect((await route("MKCOL", `${dir}fresh/`)).status).toBe(201);
    expect((await route("PROPFIND", dir, { headers: { depth: "1" } })).status).toBe(403);

    // Without the token, or with one for another epoch's grant, nothing is served.
    expect((await route("GET", key, { token: null })).status).toBe(403);
    expect((await route("HEAD", key, { token: "forged" })).status).toBe(403);
  });

  it("[FD-CACHE-056] streams a PUT body into R2 and a GET body back out as the bytes arrive", async () => {
    const size = 24 * MiB;
    const chunk = 256 * 1024;
    const digest = createHash("sha256");
    let sent = 0;
    // A body produced as it is read, so no complete copy exists on the sending side either.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= size) return controller.close();
        const bytes = new Uint8Array(chunk).map((_, i) => (sent + i) % 251);
        digest.update(bytes);
        sent += chunk;
        controller.enqueue(bytes);
      },
    });
    const key = `${REPOSITORY}/${rustc.release}/${rustc.host}/stream/large`;
    const put = await route("PUT", key, {
      body,
      headers: { "content-length": String(size), "content-type": "application/octet-stream" },
    });
    expect(put.status).toBe(201);
    expect(sent).toBe(size);
    const stored = await (await bucket()).head(`${COMPILE_CACHE_PREFIX}${PR_NAMESPACE}/${key}`);
    expect(stored?.size).toBe(size);

    const got = await route("GET", key);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-length")).toBe(String(size));
    const back = createHash("sha256");
    let received = 0;
    let reads = 0;
    const reader = got.body!.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      back.update(r.value);
      received += r.value.byteLength;
      reads += 1;
    }
    expect(received).toBe(size);
    expect(reads).toBeGreaterThan(1);
    expect(back.digest("hex")).toBe(digest.digest("hex"));
  });
});
