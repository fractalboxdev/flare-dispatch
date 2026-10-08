import { env } from "cloudflare:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { deflateRawSync, crc32 } from "node:zlib";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { nativeCommand, nativeCommandDigest, type NativeRequest } from "@fractalboxdev/flare-dispatch-core";
import { makeNativeArchiveR2 } from "./native-archive-r2";

type Member = { path: string; bytes: Uint8Array; method?: number; attrs?: number; flags?: number; size?: number; checksum?: number };
// Deterministic test-only ZIP fixture, including forced ZIP64 central records.
const zip = (members: Member[], zip64 = false) => {
  const bodies: Buffer[] = [], records: Buffer[] = []; let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.path), method = member.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(member.bytes) : Buffer.from(member.bytes);
    const checksum = member.checksum ?? crc32(member.bytes), size = member.size ?? member.bytes.length;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(member.flags ?? 0, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(Math.min(size, 0xffffffff), 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(member.flags ?? 0, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(zip64 ? 0xffffffff : compressed.length, 20); central.writeUInt32LE(zip64 ? 0xffffffff : Math.min(size, 0xffffffff), 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(member.attrs ?? 0, 38); central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    const extra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) { extra.writeUInt16LE(1); extra.writeUInt16LE(24, 2); extra.writeBigUInt64LE(BigInt(size), 4);
      extra.writeBigUInt64LE(BigInt(compressed.length), 12); extra.writeBigUInt64LE(BigInt(offset), 20); central.writeUInt16LE(extra.length, 30); }
    bodies.push(local, name, compressed); records.push(central, name, extra); offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(records), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(zip64 ? 0xffff : members.length, 8); end.writeUInt16LE(zip64 ? 0xffff : members.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12); end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  const extended: Buffer[] = [];
  if (zip64) {
    const record = Buffer.alloc(56); record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4);
    record.writeBigUInt64LE(BigInt(members.length), 24); record.writeBigUInt64LE(BigInt(members.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40); record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(offset + directory.length), 8); locator.writeUInt32LE(1, 16);
    extended.push(record, locator);
  }
  return Buffer.concat([...bodies, directory, ...extended, end]);
};
const fixture = async () => {
  const candidate: NativeRequest = { repo: "owner/context", head: "1".repeat(40), base: "2".repeat(40),
    executor_ref: "3".repeat(40), nonce: "native-0123456789abcdef", target: "aarch64-pc-windows-msvc",
    mode: "gate", profile: "", command_sha256: "0".repeat(64) };
  const request = { ...candidate, command_sha256: await Effect.runPromise(nativeCommandDigest(candidate)) };
  const log = Buffer.from("complete command fixture\n"), binary = new Uint8Array(8 * 1024 * 1024 + 17).fill(87);
  const files = [{ path: "command.log", bytes: log }, { path: "dist/context.exe", bytes: binary }];
  const receipt = { version: 1, repo: request.repo, head: request.head, base: request.base, executor_ref: request.executor_ref,
    nonce: request.nonce, target: request.target, command_sha256: request.command_sha256, command: nativeCommand(request),
    runner_os: "Windows", runner_arch: "ARM64", run_id: "123", run_attempt: "1", job: "aarch64", exit_code: 0, failure: null,
    started_at: "2026-10-08T00:00:00Z", completed_at: "2026-10-08T00:00:01Z",
    artifacts: files.map(({ path, bytes }) => ({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") })) };
  const input = { request, controllerLogin: "native-controller[bot]", api: { repo: request.repo, runId: 123, runAttempt: 1,
    event: "workflow_dispatch", executorRef: request.executor_ref, workflowPath: ".github/workflows/native-windows.yml",
    runName: `native-${request.nonce}`, status: "completed", conclusion: "success", job: "aarch64", jobStatus: "completed",
    jobConclusion: "success", actorLogin: "native-controller[bot]", actorType: "Bot", labels: ["windows-11-arm"] } };
  return { input, files, members: [...files, { path: "receipt.json", bytes: Buffer.from(JSON.stringify(receipt)) }] };
};
const key = "native-archive-pending/v1/fixture.zip";
const run = async (input: unknown, bytes: Uint8Array) => {
  await env.RUNS_STORAGE.put(key, bytes);
  return Effect.runPromise(makeNativeArchiveR2(env.RUNS_STORAGE).verify(input, key));
};

describe("bounded native ZIP extraction in workerd", () => {
  it("extracts deflated files with receipt last and preserves release bytes", async () => {
    const f = await fixture(), result = await run(f.input, zip(f.members));
    expect(result.files).toHaveLength(2); expect(result.files[1]!.chunks).toHaveLength(2);
    expect(result.verifiedArtifacts).toEqual(result.receipt.artifacts);
  });
  it("accepts stored entries, benign directories and forced ZIP64 metadata", async () => {
    const f = await fixture();
    const members = [{ path: "dist/", bytes: new Uint8Array(), attrs: 0x40000000 }, ...f.members.map((m) => ({ ...m, method: 0 }))];
    expect((await run(f.input, zip(members, true))).files).toHaveLength(2);
  });
  it("refuses traversal, aliases, symlinks, encryption and unsupported compression", async () => {
    const f = await fixture();
    for (const extra of [{ path: "../escape", bytes: Buffer.from("x") }, { path: "COMMAND.LOG", bytes: Buffer.from("x") },
      { path: "link", bytes: Buffer.from("target"), attrs: 0xa0000000 }, { path: "secret", bytes: Buffer.from("x"), flags: 1 },
      { path: "unknown", bytes: Buffer.from("x"), method: 99 }])
      await expect(run(f.input, zip([...f.members, extra]))).rejects.toThrow();
  });
  it("refuses truncated archives, oversized receipt, missing receipt and altered actual bytes", async () => {
    const f = await fixture();
    for (const bytes of [zip(f.members).subarray(0, 100), zip(f.files),
      zip([...f.files, { path: "receipt.json", bytes: Buffer.alloc(128 * 1024 + 1) }]),
      zip(f.members.map((m) => m.path === "command.log" ? { ...m, bytes: Buffer.from("wrong bytes") } : m))])
      await expect(run(f.input, bytes)).rejects.toThrow();
  });
  it("refuses an archive changed between metadata admission and its range read", async () => {
    const f = await fixture(); await env.RUNS_STORAGE.put(key, zip(f.members)); let replaced = false;
    const bucket: Pick<R2Bucket, "head" | "get" | "put"> = { head: env.RUNS_STORAGE.head.bind(env.RUNS_STORAGE), put: env.RUNS_STORAGE.put.bind(env.RUNS_STORAGE),
      get: async (...args: Parameters<R2Bucket["get"]>) => {
        if (!replaced) { replaced = true; await env.RUNS_STORAGE.put(key, "changed archive"); }
        return env.RUNS_STORAGE.get(...args);
      } };
    await expect(Effect.runPromise(makeNativeArchiveR2(bucket).verify(f.input, key))).rejects.toThrow();
  });
  it("refuses CRC corruption despite matching SHA bytes and expanded ZIP64 size bombs", async () => {
    const f = await fixture();
    await expect(run(f.input, zip(f.members.map((m) => m.path === "command.log" ? { ...m, checksum: 1 } : m)))).rejects.toThrow();
    await expect(run(f.input, zip([...f.members, { path: "bomb", bytes: Buffer.from("x"), size: 8 * 1024 * 1024 * 1024 + 1 }], true))).rejects.toThrow();
  });
});
