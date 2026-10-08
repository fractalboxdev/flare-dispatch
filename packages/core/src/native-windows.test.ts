import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { admitNativeApiEvidence, bindNativeReceipt, nativeCommand, type NativeRequest } from "./native-windows";

const request: NativeRequest = {
  repo: "owner/context", head: "1".repeat(40), base: "2".repeat(40), executor_ref: "3".repeat(40),
  nonce: "native-0123456789abcdef", target: "aarch64-pc-windows-msvc", mode: "gate", profile: "",
  command_sha256: "e964c83ffcc2427c138b484a6fc61f7ebcf70b59186899176e48da89516bb2da",
};
const receipt = () => ({
  version: 1, repo: request.repo, head: request.head, base: request.base, executor_ref: request.executor_ref,
  nonce: request.nonce, target: request.target, command_sha256: request.command_sha256,
  command: nativeCommand(request), runner_os: "Windows", runner_arch: "ARM64",
  run_id: "123", run_attempt: "1", job: "aarch64", exit_code: 0, failure: null,
  started_at: "2026-10-08T00:00:00Z", completed_at: "2026-10-08T00:00:01Z",
  artifacts: [{ path: "command.log", sha256: "5".repeat(64), bytes: 20 }],
});
const api = () => ({
  repo: request.repo, runId: 123, runAttempt: 1, event: "workflow_dispatch", executorRef: request.executor_ref,
  workflowPath: ".github/workflows/native-windows.yml", runName: `native-${request.nonce}`,
  status: "completed", conclusion: "success", job: "aarch64", jobStatus: "completed", jobConclusion: "success",
  actorLogin: "native-controller[bot]", actorType: "Bot",
  labels: ["windows-11-arm"],
});

it.effect("admits independent completed API evidence before reading workload receipts", () => Effect.gen(function* () {
  const admitted = yield* admitNativeApiEvidence(request, api(), "native-controller[bot]");
  expect(admitted).toEqual(api());
  for (const patch of [
    { repo: "other/context" }, { event: "push" }, { executorRef: "4".repeat(40) },
    { workflowPath: ".github/workflows/other.yml" }, { runName: "native-wrong-nonce" },
    { actorType: "User" }, { actorLogin: "other-controller[bot]" },
    { status: "in_progress" }, { conclusion: "failure" }, { job: "x86_64" },
    { jobStatus: "queued" }, { jobConclusion: "cancelled" }, { labels: ["windows-2025"] },
    { runId: Number.MAX_SAFE_INTEGER + 1 }, { runAttempt: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const result = yield* admitNativeApiEvidence(request, { ...api(), ...patch }, "native-controller[bot]").pipe(Effect.either);
    expect(result, JSON.stringify(patch)).toHaveProperty("left");
  }
  const result = yield* admitNativeApiEvidence(request, { ...api(), actorLogin: "" }, "").pipe(Effect.either);
  expect(result).toHaveProperty("left");
}));

it.effect("binds native receipt to authentic API job, fixed executor and actual command", () => Effect.gen(function* () {
  const accepted = yield* bindNativeReceipt(request, receipt(), api(), receipt().artifacts, "native-controller[bot]");
  expect(accepted.exit_code).toBe(0);
  expect(accepted.target).toBe("aarch64-pc-windows-msvc");
}));

it.effect("refuses absent or malformed configured controller identity even when evidence repeats it", () => Effect.gen(function* () {
  for (const login of ["", "[bot]", "native-controller", "other/controller[bot]", "native-controller[bot]extra"]) {
    const result = yield* bindNativeReceipt(request, receipt(), { ...api(), actorLogin: login },
      receipt().artifacts, login).pipe(Effect.either);
    expect(result, login).toHaveProperty("left");
  }
}));

it.effect("refuses failed API jobs, failed exits, reused nonces and mismatched artifacts", () => Effect.gen(function* () {
  const variants = [
    { receipt: receipt(), api: { ...api(), jobConclusion: "failure" } },
    { receipt: { ...receipt(), exit_code: 1 }, api: api() },
    { receipt: { ...receipt(), nonce: "native-another-nonce" }, api: api() },
    { receipt: receipt(), api: { ...api(), labels: ["windows-2025"] } },
    { receipt: receipt(), api: { ...api(), executorRef: "6".repeat(40) } },
    { receipt: { ...receipt(), command: ["cargo", "test"] }, api: api() },
    { receipt: receipt(), api: { ...api(), actorLogin: "other-controller[bot]" } },
    { receipt: receipt(), api: { ...api(), actorType: "User" } },
  ];
  for (const variant of variants) {
    const result = yield* bindNativeReceipt(request, variant.receipt, variant.api, receipt().artifacts, "native-controller[bot]").pipe(Effect.either);
    expect(result).toHaveProperty("left");
  }
  const mismatched = [{ ...receipt().artifacts[0]!, sha256: "6".repeat(64) }];
  const result = yield* bindNativeReceipt(request, receipt(), api(), mismatched, "native-controller[bot]").pipe(Effect.either);
  expect(result).toHaveProperty("left");
}));

it.effect("refuses unknown receipt fields and traversal or duplicate artifact paths", () => Effect.gen(function* () {
  for (const value of [
    { ...receipt(), unadmitted: true },
    { ...receipt(), head: "malformed" },
    { ...receipt(), artifacts: [{ path: "../release.exe", sha256: "5".repeat(64), bytes: 20 }] },
    { ...receipt(), artifacts: [...receipt().artifacts, ...receipt().artifacts] },
  ]) {
    const result = yield* bindNativeReceipt(request, value, api(), receipt().artifacts, "native-controller[bot]").pipe(Effect.either);
    expect(result).toHaveProperty("left");
  }
}));

it.effect("refuses Windows-normalized aliases and noncanonical archive members", () => Effect.gen(function* () {
  for (const path of ["dist/..", "dist/.", "dist//release.exe", "dist/release.exe.", "dist/CON.exe", "dist/aux", "dist/Lpt1.log"] ) {
    const artifacts = [...receipt().artifacts, { path, sha256: "7".repeat(64), bytes: 42 }];
    const value = { ...receipt(), artifacts };
    const result = yield* bindNativeReceipt(request, value, api(), artifacts, "native-controller[bot]").pipe(Effect.either);
    expect(result, path).toHaveProperty("left");
  }
}));
