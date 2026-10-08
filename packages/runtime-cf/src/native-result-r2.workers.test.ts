import { env } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { nativeCommand, type NativeRequest, type NativeReadBinding } from "@fractalboxdev/flare-dispatch-core";
import { makeNativeResultR2, nativeResultKey } from "./native-result-r2";

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
    await Effect.runPromise(repository.publish(evidence(), now));
    const accepted = await Effect.runPromise(repository.read(binding, now));
    expect(accepted.receipt.exit_code).toBe(0);
    const stored = await env.RUNS_STORAGE.get(nativeResultKey(binding));
    expect(stored?.size).toBeGreaterThan(0);
    await stored!.body.cancel();
    await expect(Effect.runPromise(repository.read({ ...binding, base: "4".repeat(40) }, now))).rejects.toThrow();
    await expect(Effect.runPromise(repository.read(binding, binding.expires_at))).rejects.toThrow();
  });

  it("refuses overwrite and permits exact replay after a committed publication", async () => {
    const repository = makeNativeResultR2(env.RUNS_STORAGE, controller);
    await Effect.runPromise(repository.publish(evidence(), now));
    const first = await (await env.RUNS_STORAGE.get(nativeResultKey(binding)))!.text();
    await Effect.runPromise(repository.publish(evidence(), now));
    await expect(Effect.runPromise(repository.publish(evidence(456), now))).rejects.toThrow();
    expect(await (await env.RUNS_STORAGE.get(nativeResultKey(binding)))!.text()).toBe(first);
  });

  it("admits exactly one immutable result when conflicting publications race", async () => {
    const repository = makeNativeResultR2(env.RUNS_STORAGE, controller);
    const outcomes = await Promise.allSettled([123, 456].map((id) => Effect.runPromise(repository.publish(evidence(id), now))));
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
    await expect(Effect.runPromise(makeNativeResultR2(lossy, controller).publish(evidence(), now))).rejects.toThrow();
    expect(writes).toBe(1);
    const repository = makeNativeResultR2(env.RUNS_STORAGE, controller);
    const committed = await Effect.runPromise(repository.read(binding, now));
    await Effect.runPromise(repository.publish(evidence(), now));
    expect(await Effect.runPromise(repository.read(binding, now))).toEqual(committed);
  });

  it("refuses unsigned artifact namespace, failed API evidence and mismatched verified bytes", async () => {
    const repository = makeNativeResultR2(env.RUNS_STORAGE, controller);
    await env.RUNS_STORAGE.put(`artifacts/${request.nonce}/native-result.json`, JSON.stringify(evidence()));
    await expect(Effect.runPromise(repository.read(binding, now))).rejects.toThrow();
    await expect(Effect.runPromise(repository.publish({ ...evidence(), api: { ...evidence().api, jobConclusion: "failure" } }, now))).rejects.toThrow();
    await expect(Effect.runPromise(repository.publish({ ...evidence(), verifiedArtifacts: [] }, now))).rejects.toThrow();
    await expect(Effect.runPromise(repository.publish({ ...evidence(), verifiedAt: now + 1 }, now))).rejects.toThrow();
    expect(await env.RUNS_STORAGE.get(nativeResultKey(binding))).toBeNull();
  });

  it("refuses corrupt, future and oversized stored results", async () => {
    const repository = makeNativeResultR2(env.RUNS_STORAGE, controller);
    const key = nativeResultKey(binding);
    await env.RUNS_STORAGE.put(key, "{malformed");
    await expect(Effect.runPromise(repository.read(binding, now))).rejects.toThrow();
    const raw = evidence();
    await env.RUNS_STORAGE.put(key, JSON.stringify({ version: 1, request: raw.request, receipt: raw.receipt, api: raw.api, verified_at: now + 1 }));
    await expect(Effect.runPromise(repository.read(binding, now))).rejects.toThrow();
    await env.RUNS_STORAGE.put(key, " ".repeat(128 * 1024 + 1));
    await expect(Effect.runPromise(repository.read(binding, now))).rejects.toThrow();
  });
});
