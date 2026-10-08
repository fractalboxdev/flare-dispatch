import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { bindNativeResult, type NativeReadBinding } from "./native-result";
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

it.effect("accepts only the controller-owned result matching the reader binding", () => Effect.gen(function* () {
  const accepted = yield* bindNativeResult(reader, result(), "native-controller[bot]", now);
  expect(accepted.receipt.exit_code).toBe(0);
}));

it.effect("refuses missing, expired, future, malformed and non-API-bound results", () => Effect.gen(function* () {
  const variants = [null, { ...result(), verified_at: now + 1 }, { ...result(), verified_at: Infinity },
    { ...result(), verified_at: 0 }, { ...result(), request: { ...request, mode: "release" } },
    { ...result(), api: { ...result().api, jobConclusion: "failure" } },
    { ...result(), receipt: { ...result().receipt, exit_code: 1 } },
    { ...result(), request: { ...request, nonce: "native-other-0123456789" } }];
  for (const raw of variants) {
    expect(yield* bindNativeResult(reader, raw, "native-controller[bot]", now).pipe(Effect.either)).toHaveProperty("left");
  }
  expect(yield* bindNativeResult(reader, result(), "native-controller[bot]", reader.expires_at).pipe(Effect.either)).toHaveProperty("left");
}));
