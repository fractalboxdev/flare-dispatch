import { createHash } from "node:crypto";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeCommand, type NativeReadBinding, type NativeRequest } from "@fractalboxdev/flare-dispatch-core";
import { makeTestBindings } from "@fractalboxdev/flare-dispatch-runtime-cf/testing";
import { makeNativeDispatchD1, makeNativeFilesR2, makeNativeResultR2 } from "@fractalboxdev/flare-dispatch-runtime-cf/native";
import { handleRequest } from "../router";
import { signNativeResultToken } from "../native-result-token";
import { makeFakeEnv, makeFakeR2, makeFakeWorkflow } from "../test-helpers";
import type { Env } from "../env";

const controller = { appId: 42, actorLogin: "native-controller[bot]" };
const request: NativeRequest = {
  repo: "owner/context", head: "1".repeat(40), base: "2".repeat(40), executor_ref: "3".repeat(40),
  nonce: "native-0123456789abcdef", target: "aarch64-pc-windows-msvc", mode: "gate", profile: "",
  command_sha256: "e964c83ffcc2427c138b484a6fc61f7ebcf70b59186899176e48da89516bb2da",
};
const log = new TextEncoder().encode("native command exits zero\n");
const artifact = { path: "command.log", sha256: createHash("sha256").update(log).digest("hex"), bytes: log.byteLength };
const open = async () => {
  const native = await makeTestBindings();
  // The Node proxy serializes plain conditions; workerd accepts the equivalent Headers condition.
  const bucket = { get: native.bucket.get.bind(native.bucket),
    put: ((key, value, options) => native.bucket.put(key, value, {
      ...options, ...(options?.onlyIf instanceof Headers
        ? { onlyIf: { etagDoesNotMatch: options.onlyIf.get("if-none-match")! } } : {}),
    })) as R2Bucket["put"] } as R2Bucket;
  const bindings = { ...native, bucket,
    db: { prepare: native.db.prepare.bind(native.db) } as D1Database };
  const now = Math.floor(Date.now() / 1000);
  const binding: NativeReadBinding = { version: 1, repo: request.repo, head: request.head, base: request.base,
    executor_ref: request.executor_ref, nonce: request.nonce, target: request.target,
    command_sha256: request.command_sha256, expires_at: now + 600 };
  const run = { repo: request.repo, runId: 123, runAttempt: 1, event: "workflow_dispatch",
    executorRef: request.executor_ref, workflowPath: ".github/workflows/native-windows.yml",
    runName: `native-${request.nonce}`, actorLogin: controller.actorLogin, actorType: "Bot", createdAt: new Date().toISOString() };
  const jobs = makeNativeDispatchD1(bindings.db, controller, {
    dispatch: () => Effect.void, listRuns: () => Effect.succeed([run]), readRun: () => Effect.succeed(run),
  });
  await Effect.runPromise(jobs.start(request));
  await Effect.runPromise(jobs.reconcile(request));
  const api = { ...run, status: "completed", conclusion: "success", job: "aarch64",
    jobStatus: "completed", jobConclusion: "success", labels: ["windows-11-arm"] };
  const { createdAt: _createdAt, ...completedApi } = api;
  const receipt = { version: 1, repo: request.repo, head: request.head, base: request.base,
    executor_ref: request.executor_ref, nonce: request.nonce, target: request.target,
    command_sha256: request.command_sha256, command: nativeCommand(request), runner_os: "Windows", runner_arch: "ARM64",
    run_id: "123", run_attempt: "1", job: "aarch64", exit_code: 0, failure: null,
    started_at: "2026-10-08T00:00:00Z", completed_at: "2026-10-08T00:00:01Z", artifacts: [artifact] };
  async function* entries() { yield { path: artifact.path, body: new Response(log).body! }; }
  const captured = await Effect.runPromise(makeNativeFilesR2(bindings.bucket).verify({
    request, receipt, api: completedApi, controllerLogin: controller.actorLogin,
  }, entries()));
  await Effect.runPromise(makeNativeResultR2(bindings.bucket, controller.actorLogin).publish({
    request, api: completedApi, ...captured, verifiedAt: now,
  }, now));
  const env: Env = { ...makeFakeEnv({ hmacSecret: "fixture-native-reader-key", githubAppId: "42",
    workflow: makeFakeWorkflow(), storage: makeFakeR2() }), RUNS_METADATA: bindings.db, RUNS_STORAGE: bindings.bucket };
  const authorization = await signNativeResultToken(env.HMAC_SECRET!, binding);
  return { ...bindings, env, binding, authorization };
};
const post = (body: unknown, authorization?: string, query = "") => new Request(`https://worker.test/v1/native-results/read${query}`, {
  method: "POST", headers: { "content-type": "application/json", ...(authorization === undefined ? {} : { authorization }) },
  body: JSON.stringify(body),
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("authenticated native result HTTP reads", () => {
  it.each(["stalled", "oversized"] as const)("bounds %s body disposal even when cancellation never settles", async (kind) => {
    let canceled = false, finishCancel: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { if (kind === "oversized") controller.enqueue(new Uint8Array(4097)); },
      cancel() { canceled = true; return new Promise<void>((resolve) => { finishCancel = resolve; }); },
    });
    const storage = makeFakeR2();
    const get = vi.spyOn(storage.binding, "get");
    const prepare = vi.fn(() => { throw new Error("fixture storage accessed before body admission"); });
    const env = { ...makeFakeEnv({ hmacSecret: "fixture-key", workflow: makeFakeWorkflow(), storage }),
      RUNS_METADATA: { prepare } as unknown as D1Database };
    const input = new Request("https://worker.test/v1/native-results/read", { method: "POST",
      headers: { authorization: `Bearer ${"a".repeat(22)}`, "content-type": "application/json" },
      body, duplex: "half" } as RequestInit);
    vi.useFakeTimers();
    let response: Response | undefined;
    const completed = handleRequest(input, env).then((value) => { response = value; });
    try {
      await vi.advanceTimersByTimeAsync(kind === "stalled" ? 10_001 : 1);
      expect(canceled).toBe(true);
      expect(response?.status).toBe(kind === "stalled" ? 408 : 413);
      expect(prepare).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
    } finally {
      finishCancel?.(); vi.useRealTimers(); await completed;
    }
  });

  it("serves verified metadata and actual file bytes through the typed HTTP router", async () => {
    const f = await open();
    try {
      const metadata = await handleRequest(post({ binding: f.binding }, f.authorization), f.env);
      expect(metadata.status).toBe(200);
      expect(await metadata.json()).toMatchObject({ receipt: { run_id: "123", exit_code: 0 }, files: [artifact] });
      const file = await handleRequest(post({ binding: f.binding, path: "command.log" }, f.authorization), f.env);
      expect(file.status).toBe(200);
      expect(file.headers.get("cache-control")).toBe("no-store");
      expect(file.headers.get("x-content-type-options")).toBe("nosniff");
      expect(file.headers.get("x-native-sha256")).toBe(artifact.sha256);
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(log);
    } finally { await f.dispose(); }
  });

  it("refuses missing, altered, expired and query credentials before D1 or R2 access", async () => {
    const f = await open();
    try {
      const db = vi.spyOn(f.db, "prepare"), storage = vi.spyOn(f.bucket, "get");
      for (const input of [
        post({ binding: f.binding }), post({ binding: f.binding }, "Bearer invalid"),
        post({ binding: { ...f.binding, base: "4".repeat(40) } }, f.authorization),
        post({ binding: f.binding }, undefined, `?token=${f.authorization.slice(7)}`),
      ]) expect([400, 401]).toContain((await handleRequest(input, f.env)).status);
      vi.spyOn(Date, "now").mockReturnValue(f.binding.expires_at * 1000);
      expect((await handleRequest(post({ binding: f.binding }, f.authorization), f.env)).status).toBe(401);
      expect(db).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
  });

  it("refuses foreign configured ownership and a result outside the durable run binding", async () => {
    const f = await open();
    try {
      const storage = vi.spyOn(f.bucket, "get");
      expect((await handleRequest(post({ binding: f.binding }, f.authorization), { ...f.env, GITHUB_APP_ID: "43" })).status).toBe(503);
      expect(storage).not.toHaveBeenCalled();
      await f.db.prepare("UPDATE native_dispatches SET run_id=456 WHERE repo=? AND nonce=?").bind(request.repo, request.nonce).run();
      const response = await handleRequest(post({ binding: f.binding, path: "command.log" }, f.authorization), f.env);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "native_result_unavailable" });
    } finally { await f.dispose(); }
  });

  it("refuses oversized or malformed bodies without touching either storage port", async () => {
    const f = await open();
    try {
      const db = vi.spyOn(f.db, "prepare"), storage = vi.spyOn(f.bucket, "get");
      expect((await handleRequest(post({ binding: f.binding, padding: "x".repeat(4096) }, f.authorization), f.env)).status).toBe(413);
      expect((await handleRequest(post({ binding: f.binding, controllerLogin: "other[bot]" }, f.authorization), f.env)).status).toBe(400);
      const malformed = new Request("https://worker.test/v1/native-results/read", { method: "POST",
        headers: { authorization: f.authorization, "content-type": "application/json" }, body: new Uint8Array([255, 123]) });
      expect((await handleRequest(malformed, f.env)).status).toBe(400);
      expect(db).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
  });
});
