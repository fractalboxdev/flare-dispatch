import { env } from "cloudflare:test";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { nativeCommand, NATIVE_RESULT_MAX_BYTES, type NativeRequest, type NativeReadBinding } from "@fractalboxdev/flare-dispatch-core";
import { makeNativeResultR2, nativeResultKey } from "./native-result-r2";
import { makeNativeFilesR2 } from "./native-files-r2";

const now = 1_791_417_602;
const controller = "native-controller[bot]";
const request: NativeRequest = {
  repo: "owner/context", head: "1".repeat(40), base: "2".repeat(40), executor_ref: "3".repeat(40),
  nonce: "native-0123456789abcdef", target: "aarch64-pc-windows-msvc", mode: "gate", profile: "",
  command_sha256: "e964c83ffcc2427c138b484a6fc61f7ebcf70b59186899176e48da89516bb2da",
};
const binding: NativeReadBinding = {
  version: 1, repo: request.repo, head: request.head, base: request.base, nonce: request.nonce,
  target: request.target, command_sha256: request.command_sha256, executor_ref: request.executor_ref,
  expires_at: now + 60,
};
const evidence = (runId = 123) => ({
  request,
  receipt: {
    version: 1, repo: request.repo, head: request.head, base: request.base, executor_ref: request.executor_ref,
    nonce: request.nonce, target: request.target, command_sha256: request.command_sha256,
    command: nativeCommand(request), runner_os: "Windows", runner_arch: "ARM64",
    run_id: String(runId), run_attempt: "1", job: "aarch64", exit_code: 0, failure: null,
    started_at: "2026-10-08T00:00:00Z", completed_at: "2026-10-08T00:00:01Z",
    artifacts: [{ path: "command.log", sha256: "5".repeat(64), bytes: 20 }],
  },
  api: {
    repo: request.repo, runId, runAttempt: 1, event: "workflow_dispatch", executorRef: request.executor_ref,
    workflowPath: ".github/workflows/native-windows.yml", runName: `native-${request.nonce}`,
    status: "completed", conclusion: "success", job: "aarch64", jobStatus: "completed", jobConclusion: "success",
    actorLogin: controller, actorType: "Bot", labels: ["windows-11-arm"],
  },
  verifiedArtifacts: [{ path: "command.log", sha256: "5".repeat(64), bytes: 20 }],
  verifiedAt: now,
});
const log = new TextEncoder().encode("native command exits zero\n");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const captured = async (runId = 123, extra?: Uint8Array) => {
  const raw = evidence(runId);
  const entries = [{ path: "command.log", value: log },
    ...(extra === undefined ? [] : [{ path: "dist/tool.exe", value: extra }])];
  const receipt = { ...raw.receipt, artifacts: entries.map(({ path, value }) => ({ path, sha256: hash(value), bytes: value.byteLength })) };
  async function* files() {
    for (const { path, value } of entries) {
      let offset = 0;
      yield { path, body: new ReadableStream<Uint8Array>({ pull(controller) {
        if (offset >= value.byteLength) { controller.close(); return; }
        const next = Math.min(offset + 64 * 1024, value.byteLength);
        controller.enqueue(value.subarray(offset, next)); offset = next;
      } }) };
    }
  }
  const verified = await Effect.runPromise(makeNativeFilesR2(env.RUNS_STORAGE).verify({
    request, receipt, api: raw.api, controllerLogin: controller,
  }, files()));
  return { ...raw, ...verified };
};

describe("immutable native result storage in workerd", () => {
  it("refuses publication based only on a claimed byte inventory", async () => {
    const repository = makeNativeResultR2(env.RUNS_STORAGE, controller);
    await expect(Effect.runPromise(repository.publish(evidence(), now))).rejects.toThrow();
    expect(await env.RUNS_STORAGE.get(nativeResultKey(binding))).toBeNull();
  });

  it("rejects expired reader authority before any R2 access", async () => {
    let gets = 0;
    const observed: Pick<R2Bucket, "get" | "put"> = {
      get: async (...args) => { gets++; return env.RUNS_STORAGE.get(...args); },
      put: env.RUNS_STORAGE.put.bind(env.RUNS_STORAGE),
    };
    await expect(Effect.runPromise(makeNativeResultR2(observed, controller).read(binding, binding.expires_at))).rejects.toThrow();
    expect(gets).toBe(0);
  });
  it("publishes bound controller evidence and reads it through the complete identity", async () => {
    const repository = makeNativeResultR2(env.RUNS_STORAGE, controller);
    const publication = await captured();
    await Effect.runPromise(repository.publish(publication, now));
    const accepted = await Effect.runPromise(repository.read(binding, now));
    expect(accepted.receipt.exit_code).toBe(0);
    expect(accepted.files).toHaveLength(1);
    const file = await Effect.runPromise(repository.readFile(binding, "command.log", now));
    expect(new Uint8Array(await new Response(file.body).arrayBuffer())).toEqual(log);
    const stored = await env.RUNS_STORAGE.get(nativeResultKey(binding));
    expect(stored?.size).toBeGreaterThan(0);
    await stored!.body.cancel();
    await expect(Effect.runPromise(repository.read({ ...binding, base: "4".repeat(40) }, now))).rejects.toThrow();
    await expect(Effect.runPromise(repository.read(binding, binding.expires_at))).rejects.toThrow();
  });

  it("refuses overwrite and permits exact replay after a committed publication", async () => {
    const repository = makeNativeResultR2(env.RUNS_STORAGE, controller);
    const publication = await captured();
    await Effect.runPromise(repository.publish(publication, now));
    const first = await (await env.RUNS_STORAGE.get(nativeResultKey(binding)))!.text();
    await Effect.runPromise(repository.publish(publication, now));
    await expect(Effect.runPromise(repository.publish(await captured(456), now))).rejects.toThrow();
    expect(await (await env.RUNS_STORAGE.get(nativeResultKey(binding)))!.text()).toBe(first);
  });

  it("admits exactly one immutable result when conflicting publications race", async () => {
    const repository = makeNativeResultR2(env.RUNS_STORAGE, controller);
    const publications = await Promise.all([123, 456].map((id) => captured(id)));
    const outcomes = await Promise.allSettled(publications.map((publication) => Effect.runPromise(repository.publish(publication, now))));
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const accepted = await Effect.runPromise(repository.read(binding, now));
    expect(["123", "456"]).toContain(accepted.receipt.run_id);
  });

  it("reconciles a committed R2 write whose response was lost without overwriting it", async () => {
    let writes = 0;
    const lossy: Pick<R2Bucket, "get" | "put"> = {
      get: env.RUNS_STORAGE.get.bind(env.RUNS_STORAGE),
      put: async (key, value, options) => {
        writes++;
        await env.RUNS_STORAGE.put(key, value, options);
        throw new Error("fixture response lost after actual R2 commit");
      },
    };
    const publication = await captured();
    await expect(Effect.runPromise(makeNativeResultR2(lossy, controller).publish(publication, now))).rejects.toThrow();
    expect(writes).toBe(1);
    const repository = makeNativeResultR2(env.RUNS_STORAGE, controller);
    const committed = await Effect.runPromise(repository.read(binding, now));
    await Effect.runPromise(repository.publish(publication, now));
    expect(await Effect.runPromise(repository.read(binding, now))).toEqual(committed);
  });

  it("refuses unsigned artifact namespace, failed API evidence and mismatched verified bytes", async () => {
    const repository = makeNativeResultR2(env.RUNS_STORAGE, controller);
    await env.RUNS_STORAGE.put(`artifacts/${request.nonce}/native-result.json`, JSON.stringify(evidence()));
    await expect(Effect.runPromise(repository.read(binding, now))).rejects.toThrow();
    const publication = await captured();
    await expect(Effect.runPromise(repository.publish({ ...publication, api: { ...publication.api, jobConclusion: "failure" } }, now))).rejects.toThrow();
    await expect(Effect.runPromise(repository.publish({ ...publication, verifiedArtifacts: [] }, now))).rejects.toThrow();
    await expect(Effect.runPromise(repository.publish({ ...publication, verifiedAt: now + 1 }, now))).rejects.toThrow();
    expect(await env.RUNS_STORAGE.get(nativeResultKey(binding))).toBeNull();
  });

  it("refuses corrupt, future and oversized stored results", async () => {
    const repository = makeNativeResultR2(env.RUNS_STORAGE, controller);
    const key = nativeResultKey(binding);
    await env.RUNS_STORAGE.put(key, "{malformed");
    await expect(Effect.runPromise(repository.read(binding, now))).rejects.toThrow();
    const raw = await captured();
    await env.RUNS_STORAGE.put(key, JSON.stringify({ version: 1, request: raw.request, receipt: raw.receipt, api: raw.api, files: raw.files.map(({ path, sha256, bytes, chunks }) => ({ path, sha256, bytes, chunks: chunks.map(({ sha256, bytes }) => ({ sha256, bytes })) })), verified_at: now + 1 }));
    await expect(Effect.runPromise(repository.read(binding, now))).rejects.toThrow();
    await env.RUNS_STORAGE.put(key, " ".repeat(NATIVE_RESULT_MAX_BYTES + 1));
    await expect(Effect.runPromise(repository.read(binding, now))).rejects.toThrow();
  });

  it("verifies multi-chunk executable bytes and refuses absent files, aliases and foreign chunk locations", async () => {
    const binary = new Uint8Array(8 * 1024 * 1024 + 17).fill(91);
    const publication = await captured(123, binary);
    const repository = makeNativeResultR2(env.RUNS_STORAGE, controller);
    const file = publication.files[1]!;
    const foreign = { ...publication, files: [publication.files[0]!, { ...file,
      chunks: file.chunks.map((chunk) => ({ ...chunk, key: chunk.key.replace(request.head, "4".repeat(40)) })) }] };
    await expect(Effect.runPromise(repository.publish(foreign, now))).rejects.toThrow();
    expect(await env.RUNS_STORAGE.get(nativeResultKey(binding))).toBeNull();
    await Effect.runPromise(repository.publish(publication, now));
    const result = await Effect.runPromise(repository.readFile(binding, file.path, now));
    expect(hash(new Uint8Array(await new Response(result.body).arrayBuffer()))).toBe(hash(binary));
    for (const path of ["missing.exe", "dist/TOOL.exe", "../command.log"]) {
      await expect(Effect.runPromise(repository.readFile(binding, path, now))).rejects.toThrow();
    }
  });

  it("refuses missing, truncated and corrupt actual chunks before publication or byte delivery", async () => {
    const publication = await captured();
    const repository = makeNativeResultR2(env.RUNS_STORAGE, controller);
    const chunk = publication.files[0]!.chunks[0]!;
    for (const bytes of [new Uint8Array(1), new Uint8Array(log.byteLength).fill(9)]) {
      await env.RUNS_STORAGE.put(chunk.key, bytes);
      await expect(Effect.runPromise(repository.publish(publication, now))).rejects.toThrow();
      expect(await env.RUNS_STORAGE.get(nativeResultKey(binding))).toBeNull();
    }
    await env.RUNS_STORAGE.delete(chunk.key);
    await expect(Effect.runPromise(repository.publish(publication, now))).rejects.toThrow();
    await env.RUNS_STORAGE.put(chunk.key, log);
    await Effect.runPromise(repository.publish(publication, now));
    for (const bytes of [new Uint8Array(1), new Uint8Array(log.byteLength).fill(9), null]) {
      if (bytes === null) await env.RUNS_STORAGE.delete(chunk.key);
      else await env.RUNS_STORAGE.put(chunk.key, bytes);
      const file = await Effect.runPromise(repository.readFile(binding, "command.log", now));
      const reader = file.body.getReader();
      await expect(reader.read()).rejects.toThrow();
      reader.releaseLock();
    }
  });

  it("refuses whole-file digest disagreement at stream EOF and checks expiry before file storage reads", async () => {
    const publication = await captured();
    const repository = makeNativeResultR2(env.RUNS_STORAGE, controller);
    const valid = await Effect.runPromise(repository.publish(publication, now));
    const sha256 = "7".repeat(64);
    const malformed = { ...valid,
      receipt: { ...valid.receipt, artifacts: valid.receipt.artifacts.map((file) => ({ ...file, sha256 })) },
      files: valid.files.map((file) => ({ ...file, sha256 })),
    };
    await env.RUNS_STORAGE.put(nativeResultKey(binding), JSON.stringify(malformed));
    const file = await Effect.runPromise(repository.readFile(binding, "command.log", now));
    const reader = file.body.getReader();
    expect((await reader.read()).value).toEqual(log);
    await expect(reader.read()).rejects.toThrow();
    reader.releaseLock();
    let gets = 0;
    const observed: Pick<R2Bucket, "get" | "put"> = {
      get: async (...args) => { gets++; return env.RUNS_STORAGE.get(...args); },
      put: env.RUNS_STORAGE.put.bind(env.RUNS_STORAGE),
    };
    await expect(Effect.runPromise(makeNativeResultR2(observed, controller).readFile(binding, "command.log", binding.expires_at))).rejects.toThrow();
    expect(gets).toBe(0);
  });
});
