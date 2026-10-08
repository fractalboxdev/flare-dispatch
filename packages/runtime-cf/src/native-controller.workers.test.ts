import { env } from "cloudflare:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { nativeCommand, type NativeRequest } from "@fractalboxdev/flare-dispatch-core";
import { makeNativeController } from "./native-controller";
import { makeNativeResultR2, nativeResultKey } from "./native-result-r2";

const controller = { appId: 42, actorLogin: "native-controller[bot]" };
const request: NativeRequest = { repo: "owner/context", head: "1".repeat(40), base: "2".repeat(40),
  executor_ref: "3".repeat(40), nonce: "native-0123456789abcdef", target: "aarch64-pc-windows-msvc",
  mode: "gate", profile: "", command_sha256: "e964c83ffcc2427c138b484a6fc61f7ebcf70b59186899176e48da89516bb2da" };
const log = Buffer.from("verified native command\n");
const artifact = { path: "command.log", bytes: log.length, sha256: createHash("sha256").update(log).digest("hex") };
const binding = () => ({ version: 1 as const, ...request, expires_at: Math.floor(Date.now() / 1000) + 600 });
const readerBinding = () => { const { mode: _mode, profile: _profile, ...value } = binding(); return value; };
const receipt = (nonce = request.nonce) => ({ version: 1, repo: request.repo, head: request.head, base: request.base,
  executor_ref: request.executor_ref, target: request.target, command_sha256: request.command_sha256, nonce, command: nativeCommand(request),
  runner_os: "Windows", runner_arch: "ARM64", run_id: "123", run_attempt: "1", job: "aarch64",
  exit_code: 0, failure: null, started_at: "2026-10-08T00:00:00Z", completed_at: "2026-10-08T00:00:01Z", artifacts: [artifact] });

// Small stored ZIP fixture gives the actual range reader, CRC verifier and R2 publisher their bytes.
const archive = (members: { path: string; bytes: Buffer }[]) => {
  const bodies: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.path), size = member.bytes.length, checksum = crc32(member.bytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(size, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(size, 20); central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    bodies.push(local, name, member.bytes); directory.push(central, name); offset += local.length + name.length + size;
  }
  const records = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(records.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...bodies, records, end]);
};
const open = (options: { lostDispatch?: boolean; corrupt?: boolean; foreignReceipt?: boolean; lostPublication?: boolean;
  clientRepo?: string; emptyToken?: boolean } = {}) => {
  let status = "in_progress", conclusion: string | null = null, posts = 0, downloads = 0, failPut = options.lostPublication;
  const run = () => ({ id: 123, run_attempt: 1, event: "workflow_dispatch", head_sha: request.executor_ref,
    path: ".github/workflows/native-windows.yml", display_title: `native-${request.nonce}`, repository: { full_name: request.repo },
    actor: { login: controller.actorLogin, type: "Bot" }, created_at: new Date().toISOString(), status, conclusion });
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(String(url));
    if (init?.method === "POST") { posts++; if (options.lostDispatch) throw new Error("accepted response lost"); return new Response(null, { status: 204 }); }
    if (target.pathname.endsWith("/native-windows.yml/runs")) return Response.json({ total_count: 1, workflow_runs: [run()] });
    if (target.pathname.endsWith("/attempts/1")) return Response.json(run());
    if (target.pathname.endsWith("/jobs")) return Response.json({ total_count: 1, jobs: [{ id: 456, run_id: 123,
      head_sha: request.executor_ref, name: "aarch64", status: "completed", conclusion: "success", labels: ["windows-11-arm"] }] });
    if (target.pathname.endsWith("/artifacts")) return Response.json({ total_count: 1, artifacts: [{ id: 789,
      name: `native-${request.nonce}`, expired: false, size_in_bytes: 1024, workflow_run: { id: 123, head_sha: request.executor_ref } }] });
    if (target.pathname.endsWith("/789/zip")) return new Response(null, { status: 302, headers: { location: "https://archive.example/bytes" } });
    if (target.hostname === "archive.example") {
      expect(new Headers(init?.headers).has("authorization")).toBe(false); downloads++;
      return new Response(archive([{ path: "command.log", bytes: options.corrupt ? Buffer.from("altered bytes") : log },
        { path: "receipt.json", bytes: Buffer.from(JSON.stringify(receipt(options.foreignReceipt ? "native-ffffffffffffffff" : undefined))) }]));
    }
    throw new Error(`unexpected fixture path ${target.pathname}`);
  };
  const bucket = { head: env.RUNS_STORAGE.head.bind(env.RUNS_STORAGE), get: env.RUNS_STORAGE.get.bind(env.RUNS_STORAGE),
    delete: env.RUNS_STORAGE.delete.bind(env.RUNS_STORAGE), createMultipartUpload: env.RUNS_STORAGE.createMultipartUpload.bind(env.RUNS_STORAGE),
    put: (async (...args: Parameters<R2Bucket["put"]>) => {
      const value = await env.RUNS_STORAGE.put(...args);
      if (failPut && args[0].startsWith("native-results/")) { failPut = false; throw new Error("publication acknowledgement lost"); }
      return value;
    }) as R2Bucket["put"] } as R2Bucket;
  const instance = makeNativeController({ db: env.RUNS_METADATA, bucket, controller,
    client: { repo: options.clientRepo ?? request.repo, token: options.emptyToken ? "" : "fixture-installation-token", fetchImpl } });
  return { instance, bucket, posts: () => posts, downloads: () => downloads,
    finish: (value = "success") => { status = "completed"; conclusion = value; } };
};

describe("native controller with actual D1 and R2", () => {
  it.each([{ clientRepo: "other/context" }, { emptyToken: true }])("refuses invalid credential scope before reserving a dispatch intent", async (options) => {
    const f = open(options);
    await expect(Effect.runPromise(f.instance.advance(request))).rejects.toThrow();
    expect(f.posts()).toBe(0); expect(f.downloads()).toBe(0);
    expect(await env.RUNS_METADATA.prepare("SELECT count(*) AS count FROM native_dispatches").first("count")).toBe(0);
  });
  it("reconciles an accepted lost POST, waits, publishes bytes and replays without another dispatch or download", async () => {
    const f = open({ lostDispatch: true });
    expect(await Effect.runPromise(f.instance.advance(request))).toMatchObject({ _tag: "Running", runId: 123, runAttempt: 1 });
    expect(f.posts()).toBe(1); expect(f.downloads()).toBe(0);
    expect(await env.RUNS_STORAGE.head(nativeResultKey(readerBinding()))).toBeNull();
    f.finish();
    expect(await Effect.runPromise(f.instance.advance(request))).toMatchObject({ _tag: "Published", result: { receipt: { exit_code: 0 } } });
    const file = await Effect.runPromise(makeNativeResultR2(f.bucket, controller.actorLogin).readFile(readerBinding(), "command.log", Math.floor(Date.now() / 1000)));
    expect(Buffer.from(await new Response(file.body).arrayBuffer())).toEqual(log);
    expect(await Effect.runPromise(f.instance.advance(request))).toMatchObject({ _tag: "Published" });
    expect(f.posts()).toBe(1); expect(f.downloads()).toBe(1);
    expect((await env.RUNS_STORAGE.list({ prefix: "native-archive-pending/" })).objects).toEqual([]);
  });
  it("retains authentic terminal failure without downloading or publishing successful results", async () => {
    const f = open(); f.finish("failure");
    expect(await Effect.runPromise(f.instance.advance(request))).toMatchObject({ _tag: "Failed", conclusion: "failure", runId: 123, runAttempt: 1 });
    expect(f.posts()).toBe(1); expect(f.downloads()).toBe(0);
    expect(await env.RUNS_STORAGE.head(nativeResultKey(readerBinding()))).toBeNull();
  });
  it.each([{ corrupt: true }, { foreignReceipt: true }])("rejects invalid archive evidence and removes only its temporary archive", async (options) => {
    const f = open(options); f.finish();
    await expect(Effect.runPromise(f.instance.advance(request))).rejects.toThrow();
    expect(await env.RUNS_STORAGE.head(nativeResultKey(readerBinding()))).toBeNull();
    expect((await env.RUNS_STORAGE.list({ prefix: "native-archive-pending/" })).objects).toEqual([]);
  });
  it("recovers a persisted result after lost publication acknowledgement without republishing", async () => {
    const f = open({ lostPublication: true }); f.finish();
    await expect(Effect.runPromise(f.instance.advance(request))).rejects.toThrow();
    expect(await Effect.runPromise(f.instance.advance(request))).toMatchObject({ _tag: "Published" });
    expect(f.posts()).toBe(1); expect(f.downloads()).toBe(1);
    expect((await env.RUNS_STORAGE.list({ prefix: "native-archive-pending/" })).objects).toEqual([]);
  });
});
