import { env } from "cloudflare:test";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { nativeCommand, nativeCommandDigest, type NativeRequest } from "@fractalboxdev/flare-dispatch-core";
import { makeNativeFilesR2 } from "./native-files-r2";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const log = new TextEncoder().encode("actual command output\n");
const controller = "native-controller[bot]";
const fixture = async (files = [{ path: "command.log", bytes: log }]) => {
  const candidate: NativeRequest = {
    repo: "owner/context", head: "1".repeat(40), base: "2".repeat(40), executor_ref: "3".repeat(40),
    nonce: "native-0123456789abcdef", target: "aarch64-pc-windows-msvc", mode: "gate", profile: "",
    command_sha256: "0".repeat(64),
  };
  const request = { ...candidate, command_sha256: await Effect.runPromise(nativeCommandDigest(candidate)) };
  return { request, controllerLogin: controller, receipt: {
    version: 1, ...request, mode: undefined, profile: undefined,
    command: nativeCommand(request), runner_os: "Windows", runner_arch: "ARM64",
    run_id: "123", run_attempt: "1", job: "aarch64", exit_code: 0, failure: null,
    started_at: "2026-10-08T00:00:00Z", completed_at: "2026-10-08T00:00:01Z",
    artifacts: files.map(({ path, bytes }) => ({ path, bytes: bytes.byteLength, sha256: sha(bytes) })),
  }, api: {
    repo: request.repo, runId: 123, runAttempt: 1, event: "workflow_dispatch", executorRef: request.executor_ref,
    workflowPath: ".github/workflows/native-windows.yml", runName: `native-${request.nonce}`,
    status: "completed", conclusion: "success", job: "aarch64", jobStatus: "completed", jobConclusion: "success",
    actorLogin: controller, actorType: "Bot", labels: ["windows-11-arm"],
  } };
};
const entries = async function* (files: readonly { path: string; bytes: Uint8Array }[]) {
  for (const file of files) yield { path: file.path, body: new ReadableStream<Uint8Array>({
    start(c) { for (let i = 0; i < file.bytes.byteLength; i += 65536) c.enqueue(file.bytes.slice(i, i + 65536)); c.close(); },
  }) };
};
const evidence = async (files?: { path: string; bytes: Uint8Array }[]) => {
  const value = await fixture(files);
  delete value.receipt.mode; delete value.receipt.profile;
  return value;
};

describe("native file bytes in actual R2", () => {
  it("hashes streamed log and release files and persists immutable content chunks", async () => {
    const binary = new Uint8Array(8 * 1024 * 1024 + 17).fill(91);
    const files = [{ path: "command.log", bytes: log }, { path: "dist/context.exe", bytes: binary }];
    const store = makeNativeFilesR2(env.RUNS_STORAGE);
    const result = await Effect.runPromise(store.verify(await evidence(files), entries(files)));
    expect(result.files[1]!.chunks).toHaveLength(2);
    for (const file of result.files) {
      const pieces = await Promise.all(file.chunks.map(async (chunk) => new Uint8Array(await (await env.RUNS_STORAGE.get(chunk.key))!.arrayBuffer())));
      expect(pieces.reduce((size, bytes) => size + bytes.byteLength, 0)).toBe(file.bytes);
      const digest = createHash("sha256"); pieces.forEach((bytes) => digest.update(bytes));
      expect(digest.digest("hex")).toBe(file.sha256);
    }
    expect(await Effect.runPromise(store.verify(await evidence(files), entries(files)))).toEqual(result);
  });

  it("refuses changed, truncated, missing, extra and case-aliased file bytes", async () => {
    const store = makeNativeFilesR2(env.RUNS_STORAGE), input = await evidence();
    for (const files of [
      [{ path: "command.log", bytes: new Uint8Array(log.length).fill(1) }],
      [{ path: "command.log", bytes: log.slice(1) }], [],
      [{ path: "command.log", bytes: log }, { path: "extra.txt", bytes: log }],
      [{ path: "command.log", bytes: log }, { path: "COMMAND.LOG", bytes: log }],
    ]) await expect(Effect.runPromise(store.verify(input, entries(files)))).rejects.toThrow();
  });

  it("refuses untrusted API before consuming or storing archive entries", async () => {
    const input = await evidence(); let consumed = false;
    const source = async function* () { consumed = true; yield* entries([{ path: "command.log", bytes: log }]); };
    await expect(Effect.runPromise(makeNativeFilesR2(env.RUNS_STORAGE).verify({ ...input, api: { ...input.api, actorLogin: "caller[bot]" } }, source()))).rejects.toThrow();
    expect(consumed).toBe(false);
    expect((await env.RUNS_STORAGE.list()).objects).toHaveLength(0);
  });

  it("refuses corrupt immutable chunks and reconciles a committed write with a lost response", async () => {
    const input = await evidence(), source = () => entries([{ path: "command.log", bytes: log }]);
    let writes = 0;
    const lossy = { get: env.RUNS_STORAGE.get.bind(env.RUNS_STORAGE), put: async (...args: Parameters<R2Bucket["put"]>) => {
      writes++; await env.RUNS_STORAGE.put(...args); throw new Error("fixture lost response");
    } };
    await expect(Effect.runPromise(makeNativeFilesR2(lossy).verify(input, source()))).rejects.toThrow();
    expect(writes).toBe(1);
    const store = makeNativeFilesR2(env.RUNS_STORAGE), result = await Effect.runPromise(store.verify(input, source()));
    const key = result.files[0]!.chunks[0]!.key;
    await env.RUNS_STORAGE.put(key, "corrupt");
    await expect(Effect.runPromise(store.verify(input, source()))).rejects.toThrow();
    expect(await (await env.RUNS_STORAGE.get(key))!.text()).toBe("corrupt");
  });

  it("refuses producer failure and oversized input chunks", async () => {
    const input = await evidence();
    for (const body of [new ReadableStream<Uint8Array>({ start(c) { c.error(new Error("fixture truncation")); } }),
      new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(256 * 1024 + 1)); c.close(); } })]) {
      const source = async function* () { yield { path: "command.log", body }; };
      await expect(Effect.runPromise(makeNativeFilesR2(env.RUNS_STORAGE).verify(input, source()))).rejects.toThrow();
    }
  });
});
