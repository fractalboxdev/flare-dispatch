import { env } from "cloudflare:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { nativeCommand, type NativeRequest, type NativeReceiptRefused, type NativeControllerPolicy } from "@fractalboxdev/flare-dispatch-core";
import { makeNativeController } from "./native-controller";
import * as native from "./native";
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
  clientRepo?: string; emptyToken?: boolean; authenticated?:boolean; checkpoint?:boolean; undiscovered?:boolean;
  foreignApp?:boolean; broadGrant?:boolean; delayArchive?:boolean; policy?:NativeControllerPolicy; clock?: () => number } = {}) => {
  let status = "in_progress", conclusion: string | null = null, posts = 0, downloads = 0, failPut = options.lostPublication;
  let authReads=0, grants=0;
  const run = () => ({ id: 123, run_attempt: 1, event: "workflow_dispatch", head_sha: request.executor_ref,
    path: ".github/workflows/native-windows.yml", display_title: `native-${request.nonce}`, repository: { full_name: request.repo },
    actor: { login: controller.actorLogin, type: "Bot" }, created_at: new Date().toISOString(), status, conclusion });
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(String(url));
    if (target.pathname === "/app") {
      authReads++; expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-app-jwt");
      return Response.json({id:options.foreignApp ? 43 : 42,slug:"native-controller"});
    }
    if (target.pathname.endsWith("/installation")) {
      authReads++; expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-app-jwt");
      return Response.json({id:77,app_id:42,account:{login:"owner"},suspended_at:null,permissions:{actions:"write"}});
    }
    if (target.pathname.endsWith("/access_tokens")) {
      grants++; expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-app-jwt");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({repositories:["context"],permissions:{actions:"write",metadata:"read"}});
      return Response.json({token:"fixture-installation-token",expires_at:new Date(Date.now()+3600_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
        repository_selection:options.broadGrant ? "all" : "selected",repositories:[{name:"context",full_name:request.repo}],
        permissions:{actions:"write",metadata:"read"}},{status:201});
    }
    if (target.hostname !== "archive.example")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-installation-token");
    if (init?.method === "POST") { posts++; if (options.lostDispatch) throw new Error("accepted response lost"); return new Response(null, { status: 204 }); }
    if (target.pathname.endsWith("/native-windows.yml/runs")) return Response.json({ total_count: options.undiscovered ? 0 : 1,
      workflow_runs: options.undiscovered ? [] : [run()] });
    if (target.pathname.endsWith("/attempts/1")) return Response.json(run());
    if (target.pathname.endsWith("/jobs")) return Response.json({ total_count: 1, jobs: [{ id: 456, run_id: 123,
      head_sha: request.executor_ref, name: "aarch64", status: "completed", conclusion: "success", labels: ["windows-11-arm"] }] });
    if (target.pathname.endsWith("/artifacts")) return Response.json({ total_count: 1, artifacts: [{ id: 789,
      name: `native-${request.nonce}`, expired: false, size_in_bytes: 1024, workflow_run: { id: 123, head_sha: request.executor_ref } }] });
    if (target.pathname.endsWith("/789/zip")) return new Response(null, { status: 302, headers: { location: "https://archive.example/bytes" } });
    if (target.hostname === "archive.example") {
      expect(new Headers(init?.headers).has("authorization")).toBe(false); downloads++;
      if(options.delayArchive) await new Promise((resolve)=>setTimeout(resolve,1100));
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
  type Outcome = Effect.Effect.Success<ReturnType<typeof native.advanceNativeController>> | native.NativeControllerCheckpoint;
  const instance: { advance: (raw: unknown) => Effect.Effect<Outcome, NativeReceiptRefused> } = options.authenticated ? { advance:(raw:unknown) =>
    (options.checkpoint ? native.advanceNativeControllerCheckpoint : native.advanceNativeController)({db:env.RUNS_METADATA,bucket,now: options.clock, policy:options.policy, auth:{appId:"42",appJwt:"fixture-app-jwt",
        repo:options.clientRepo ?? request.repo,fetchImpl}},raw) } :
    makeNativeController({ db: env.RUNS_METADATA, bucket, controller, now: options.clock,
      client: { repo: options.clientRepo ?? request.repo, token: options.emptyToken ? "" : "fixture-installation-token", fetchImpl } });
  return { instance, bucket, posts: () => posts, downloads: () => downloads,
    authReads:()=>authReads,grants:()=>grants,
    finish: (value = "success") => { status = "completed"; conclusion = value; } };
};

describe("native controller with actual D1 and R2", () => {
  it("refuses publication after archive capture crosses the durable deadline and removes its temporary archive", async () => {
    const f = open({ authenticated:true,checkpoint:true,policy:{timeoutSec:1},delayArchive:true });
    f.finish();
    await expect(Effect.runPromise(f.instance.advance(request))).rejects.toThrow();
    expect(f.posts()).toBe(1); expect(f.downloads()).toBe(1);
    expect(await env.RUNS_STORAGE.head(nativeResultKey(readerBinding()))).toBeNull();
    expect((await env.RUNS_STORAGE.list({prefix:"native-archive-pending/"})).objects).toEqual([]);
  });
  it("carries the immutable durable deadline through authenticated running and publication checkpoints", async () => {
    const f = open({ authenticated:true, checkpoint:true, policy:{timeoutSec:60} });
    const first = await Effect.runPromise(f.instance.advance(request));
    const intent = await env.RUNS_METADATA.prepare("SELECT admitted_at,deadline_at FROM native_dispatches WHERE repo=? AND nonce=?")
      .bind(request.repo,request.nonce).first<{admitted_at:number;deadline_at:number}>();
    expect(first).toMatchObject({admittedAt:intent!.admitted_at,deadlineAt:intent!.admitted_at+60});
    expect(intent!.deadline_at).toBe(intent!.admitted_at+60);
    f.finish();
    expect(await Effect.runPromise(f.instance.advance(request))).toMatchObject({_tag:"Published",admittedAt:intent!.admitted_at,deadlineAt:intent!.deadline_at});
    expect(await Effect.runPromise(f.instance.advance(request))).toMatchObject({_tag:"Published",deadlineAt:intent!.deadline_at});
    expect(f.posts()).toBe(1);expect(f.downloads()).toBe(1);
  });
  it("checkpoints authenticated replay as metadata without result bodies or credentials", async () => {
    const f = open({ authenticated: true, checkpoint: true, lostDispatch: true });
    const pending = await Effect.runPromise(f.instance.advance(request));
    expect(pending).toEqual({ _tag: "Running", runId: 123, runAttempt: 1, status: "in_progress", admittedAt: expect.any(Number) });
    f.finish();
    const published = await Effect.runPromise(f.instance.advance(request));
    expect(published).toEqual({ _tag: "Published", runId: 123, runAttempt: 1,
      admittedAt: pending.admittedAt, manifestKey: nativeResultKey(readerBinding()) });
    expect(await Effect.runPromise(f.instance.advance(request))).toEqual(published);
    expect(f.posts()).toBe(1); expect(f.downloads()).toBe(1); expect(f.grants()).toBe(3);
    for (const forbidden of ["fixture-app-jwt", "fixture-installation-token", "receipt", "files", "verified native command"])
      expect(JSON.stringify(published)).not.toContain(forbidden);
    const file = await Effect.runPromise(makeNativeResultR2(f.bucket, controller.actorLogin)
      .readFile(readerBinding(), "command.log", Math.floor(Date.now() / 1000)));
    expect(Buffer.from(await new Response(file.body).arrayBuffer())).toEqual(log);
  });
  it("checkpoints an undiscovered accepted dispatch without inventing a run or result", async () => {
    const f = open({ authenticated: true, checkpoint: true, undiscovered: true });
    expect(await Effect.runPromise(f.instance.advance(request))).toEqual({ _tag: "WaitingForRun", admittedAt: expect.any(Number) });
    expect(f.posts()).toBe(1); expect(f.downloads()).toBe(0);
  });
  it("checkpoints authentic terminal failure without a result manifest", async () => {
    const f = open({ authenticated: true, checkpoint: true }); f.finish("cancelled");
    expect(await Effect.runPromise(f.instance.advance(request))).toEqual({ _tag: "Failed", admittedAt: expect.any(Number),
      runId: 123, runAttempt: 1, conclusion: "cancelled" });
    expect(f.downloads()).toBe(0);
    expect(await env.RUNS_STORAGE.head(nativeResultKey(readerBinding()))).toBeNull();
  });
  it("keeps the persisted admission clock across delayed polling and publication", async () => {
    let now = Math.floor(Date.now() / 1000);
    const f = open({ clock: () => now });
    const first = await Effect.runPromise(f.instance.advance(request));
    expect(first).toMatchObject({ _tag: "Running", admittedAt: expect.any(Number) });
    const admittedAt = Number("admittedAt" in first ? first.admittedAt : NaN);
    expect(await env.RUNS_METADATA.prepare("SELECT admitted_at FROM native_dispatches WHERE repo=? AND nonce=?")
      .bind(request.repo, request.nonce).first("admitted_at")).toBe(admittedAt);
    now += 1800;
    expect(await Effect.runPromise(f.instance.advance(request))).toMatchObject({ _tag: "Running", admittedAt });
    f.finish();
    expect(await Effect.runPromise(f.instance.advance(request))).toMatchObject({ _tag: "Published", admittedAt });
    expect(f.posts()).toBe(1);
  });
  it("authenticates each advance and preserves single dispatch/archive publication across replay", async () => {
    const f=open({authenticated:true,lostDispatch:true});
    expect(await Effect.runPromise(f.instance.advance(request))).toMatchObject({_tag:"Running",runId:123,runAttempt:1});
    f.finish();
    const result=await Effect.runPromise(f.instance.advance(request));
    expect(result).toMatchObject({_tag:"Published",result:{receipt:{exit_code:0}}});
    expect(await Effect.runPromise(f.instance.advance(request))).toMatchObject({_tag:"Published"});
    expect(f.posts()).toBe(1);expect(f.downloads()).toBe(1);
    expect(f.authReads()).toBe(6);expect(f.grants()).toBe(3);
    expect(JSON.stringify(result)).not.toContain("fixture-app-jwt");
    expect(JSON.stringify(result)).not.toContain("fixture-installation-token");
    const persisted=await env.RUNS_METADATA.prepare("SELECT * FROM native_dispatches").all();
    expect(JSON.stringify(persisted)).not.toContain("fixture-app-jwt");
    expect(JSON.stringify(persisted)).not.toContain("fixture-installation-token");
    const file=await Effect.runPromise(makeNativeResultR2(f.bucket,controller.actorLogin).readFile(readerBinding(),"command.log",Math.floor(Date.now()/1000)));
    expect(Buffer.from(await new Response(file.body).arrayBuffer())).toEqual(log);
  });
  it.each([{foreignApp:true},{broadGrant:true},{clientRepo:"other/context"}])("rejects untrusted authenticated scope without dispatch reservation",async(options)=>{
    const f=open({...options,authenticated:true});
    await expect(Effect.runPromise(f.instance.advance(request))).rejects.toThrow();
    expect(f.posts()).toBe(0);expect(f.downloads()).toBe(0);
    expect(await env.RUNS_METADATA.prepare("SELECT count(*) AS count FROM native_dispatches").first("count")).toBe(0);
    if(options.clientRepo !== undefined){expect(f.authReads()).toBe(0);expect(f.grants()).toBe(0);}
  });
  it("rejects a malformed native request before authentication",async()=>{
    const f=open({authenticated:true});
    await expect(Effect.runPromise(f.instance.advance({...request,command_sha256:"0".repeat(64)}))).rejects.toThrow();
    expect(f.authReads()).toBe(0);expect(f.grants()).toBe(0);expect(f.posts()).toBe(0);
    expect(await env.RUNS_METADATA.prepare("SELECT count(*) AS count FROM native_dispatches").first("count")).toBe(0);
  });
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
