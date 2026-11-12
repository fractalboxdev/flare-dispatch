import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { bindNativeResult, NATIVE_FILE_CHUNK_BYTES, NATIVE_FILES_MAX_BYTES, NATIVE_RESULT_MAX_BYTES, type NativeReadBinding } from "./native-result";
import { nativeCommand, type NativeRequest } from "./native-windows";

const now = 1_791_417_602;
const request: NativeRequest = {
  repo: "owner/context", head: "1".repeat(40), base: "2".repeat(40), executor_ref: "3".repeat(40),
  nonce: "native-0123456789abcdef", target: "aarch64-pc-windows-msvc", mode: "gate", profile: "",
  command_sha256: "e964c83ffcc2427c138b484a6fc61f7ebcf70b59186899176e48da89516bb2da",
};
const binding: NativeReadBinding = { version: 1, ...request, expires_at: now + 60 };
// The binding excludes workload knobs; their canonical command digest carries them.
const reader: NativeReadBinding = {
  version: binding.version, repo: binding.repo, head: binding.head, base: binding.base,
  nonce: binding.nonce, target: binding.target, command_sha256: binding.command_sha256,
  executor_ref: binding.executor_ref, expires_at: binding.expires_at,
};
const result = () => ({
  version: 1, request, verified_at: now,
  receipt: {
    version: 1, repo: request.repo, head: request.head, base: request.base, executor_ref: request.executor_ref,
    nonce: request.nonce, target: request.target, command_sha256: request.command_sha256,
    command: nativeCommand(request), runner_os: "Windows", runner_arch: "ARM64",
    run_id: "123", run_attempt: "1", job: "aarch64", exit_code: 0, failure: null,
    started_at: "2026-10-08T00:00:00Z", completed_at: "2026-10-08T00:00:01Z",
    artifacts: [{ path: "command.log", sha256: "5".repeat(64), bytes: 20 }],
  },
  api: {
    repo: request.repo, runId: 123, runAttempt: 1, event: "workflow_dispatch", executorRef: request.executor_ref,
    workflowPath: ".github/workflows/native-windows.yml", runName: `native-${request.nonce}`,
    status: "completed", conclusion: "success", job: "aarch64", jobStatus: "completed", jobConclusion: "success",
    actorLogin: "native-controller[bot]", actorType: "Bot", labels: ["windows-11-arm"],
  },
});
const withFiles = () => ({ ...result(), files: [{ path: "command.log", sha256: "5".repeat(64), bytes: 20,
  chunks: [{ sha256: "5".repeat(64), bytes: 20 }] }] });

it.effect("accepts only the controller-owned result matching the reader binding", () => Effect.gen(function* () {
  const accepted = yield* bindNativeResult(reader, withFiles(), "native-controller[bot]", now);
  expect(accepted.receipt.exit_code).toBe(0);
}));

it.effect("binds complete bounded file manifests and refuses missing, aliased or malformed chunk inventories", () => Effect.gen(function* () {
  const good = withFiles();
  const file = good.files[0]!;
  const variants = [{ ...good, files: [] }, { ...good, files: [file, file] },
    { ...good, files: [{ ...file, path: "other.log" }] },
    { ...good, files: [{ ...file, chunks: [] }] },
    { ...good, files: [{ ...file, chunks: [{ sha256: file.sha256, bytes: 19 }] }] },
    { ...good, files: [{ ...file, chunks: [{ sha256: file.sha256, bytes: 10 }, { sha256: file.sha256, bytes: 10 }] }] },
    { ...good, files: [{ ...file, chunks: [{ sha256: "BAD", bytes: 20 }] }] }];
  for (const raw of variants) expect(yield* bindNativeResult(reader, raw, "native-controller[bot]", now).pipe(Effect.either)).toHaveProperty("left");
}));

it.effect("refuses a receipt-only result without verified file locations", () => Effect.gen(function* () {
  expect(yield* bindNativeResult(reader, result(), "native-controller[bot]", now).pipe(Effect.either)).toHaveProperty("left");
}));

it.effect("refuses missing, expired, future, malformed and non-API-bound results", () => Effect.gen(function* () {
  const good = withFiles();
  const variants = [null, { ...good, verified_at: now + 1 }, { ...good, verified_at: Infinity },
    { ...good, verified_at: 0 }, { ...good, request: { ...request, mode: "release" } },
    { ...good, api: { ...good.api, jobConclusion: "failure" } },
    { ...good, receipt: { ...good.receipt, exit_code: 1 } },
    { ...good, request: { ...request, nonce: "native-other-0123456789" } }];
  for (const raw of variants) {
    expect(yield* bindNativeResult(reader, raw, "native-controller[bot]", now).pipe(Effect.either)).toHaveProperty("left");
  }
  expect(yield* bindNativeResult(reader, good, "native-controller[bot]", reader.expires_at).pipe(Effect.either)).toHaveProperty("left");
}));

it.effect("represents the maximum admitted byte inventory within the bounded compact result record", () => Effect.gen(function* () {
  const good = withFiles();
  const bytes = NATIVE_FILES_MAX_BYTES - good.files[0]!.bytes;
  const chunks = Array.from({ length: Math.ceil(bytes / NATIVE_FILE_CHUNK_BYTES) }, (_, index) => ({
    sha256: "6".repeat(64), bytes: Math.min(NATIVE_FILE_CHUNK_BYTES, bytes - index * NATIVE_FILE_CHUNK_BYTES),
  }));
  const binary = { path: "dist/tool.exe", sha256: "7".repeat(64), bytes, chunks };
  const large = { ...good, files: [...good.files, binary], receipt: { ...good.receipt,
    artifacts: [...good.receipt.artifacts, { path: binary.path, sha256: binary.sha256, bytes }] } };
  const accepted = yield* bindNativeResult(reader, large, "native-controller[bot]", now);
  expect(new TextEncoder().encode(JSON.stringify(accepted)).byteLength).toBeLessThan(NATIVE_RESULT_MAX_BYTES);
  const overflow = { ...binary, bytes: bytes + 1, chunks: [...chunks.slice(0, -1), { ...chunks.at(-1)!, bytes: chunks.at(-1)!.bytes + 1 }] };
  expect(yield* bindNativeResult(reader, { ...large, files: [good.files[0]!, overflow] }, "native-controller[bot]", now).pipe(Effect.either)).toHaveProperty("left");
}));
