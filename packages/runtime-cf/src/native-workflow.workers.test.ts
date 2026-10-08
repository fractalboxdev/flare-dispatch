import { env, introspectWorkflowInstance, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeNativeResultR2 } from "./native-result-r2";
const nativeWorkflowId = async (request: unknown) => (await SELF.fetch(new Request("https://fixture.test/native-id", {
  method: "POST", body: JSON.stringify(request),
}))).text();

const request = { repo: "owner/context", head: "1".repeat(40), base: "2".repeat(40), executor_ref: "3".repeat(40),
  nonce: "native-0123456789abcdef", target: "aarch64-pc-windows-msvc" as const, mode: "gate" as const, profile: "" as const,
  command_sha256: "e964c83ffcc2427c138b484a6fc61f7ebcf70b59186899176e48da89516bb2da" };
const policy = { repo: request.repo, executor_ref: request.executor_ref, timeoutSec: 60, pollIntervalSec: 30 };
const poll = (checkpoint: unknown, pollIntervalSec = 30, now = 1000) => SELF.fetch(new Request("https://fixture.test/fixture/poll", {
  method: "POST", body: JSON.stringify({ checkpoint, pollIntervalSec, now }),
}));
const apiCalls = async () => (await env.NATIVE_FIXTURE_CONTROL.fetch("https://fixture.test/snapshot")).json<{calls: {method:string;path:string}[]}>();
const seed = async (secondsAgo: number, nonce = request.nonce) => {
  await env.RUNS_METADATA.prepare(`INSERT INTO native_dispatches
    (repo,nonce,request_json,controller_app_id,controller_login,state,admitted_at,timeout_sec,deadline_at)
    VALUES(?,?,?,?,?,'reserved',unixepoch('now')-?,60,unixepoch('now')-?+60)`)
    .bind(request.repo, nonce, JSON.stringify({ ...request, nonce }), 42, "native-controller[bot]", secondsAgo, secondsAgo).run();
};

beforeEach(async () => { await env.NATIVE_FIXTURE_CONTROL.fetch("https://fixture.test/reset"); });

describe("production NativeWorkflow with actual local Workflow and D1 bindings", () => {
  it.each([0,-1,0.5,Number.MAX_SAFE_INTEGER+1])("refuses malformed polling duration %s at the checkpoint boundary", async interval => {
    expect((await poll({ _tag: "WaitingForRun", admittedAt: 900, deadlineAt: 1200 }, interval)).status).toBe(503);
  });
  it("bounds the complete UTF8 checkpoint envelope and refuses malformed IDs, clocks and expiry", async () => {
    const running = { _tag: "Running", admittedAt: 900, deadlineAt: 1200, runId: 123, runAttempt: 1, status: "queued" };
    expect(await (await poll(running, 30, 1195)).json()).toMatchObject({ nextPollAt: 1200 });
    for (const changed of [{ runId: 0 }, { runAttempt: 0 }, { admittedAt: -1 }, { deadlineAt: undefined }, { token: "fixture-forbidden" }])
      expect((await poll({ ...running, ...changed })).status).toBe(503);
    expect((await poll(running, 30, 1200)).status).toBe(503);
    const published = { _tag: "Published", admittedAt: 900, deadlineAt: 1200, runId: 123, runAttempt: 1, manifestKey: "" };
    const length = (2 ** 20) - new TextEncoder().encode(JSON.stringify(published)).byteLength;
    expect((await poll({ ...published, manifestKey: "x".repeat(length) })).status).toBe(503);
  });
  it("refuses a native authenticated redirect without following or forwarding credentials",async()=>{
    await env.NATIVE_FIXTURE_CONTROL.fetch("https://fixture.test/reset?redirect=1");
    expect((await SELF.fetch("https://fixture.test/fixture/default-context")).status).toBe(503);
    expect((await apiCalls()).calls).toEqual([{method:"GET",path:"/app"}]);
  });
  it("admits the default SDK fetch transport in workerd without an injected client function",async()=>{
    expect((await SELF.fetch("https://fixture.test/fixture/direct-fetch")).status).toBe(401);
    expect((await apiCalls()).calls).toEqual([{method:"GET",path:"/app"}]);
    await env.NATIVE_FIXTURE_CONTROL.fetch("https://fixture.test/reset");
    const response=await SELF.fetch("https://fixture.test/fixture/default-context");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({appId:42,actorLogin:"native-controller[bot]"});
    expect((await apiCalls()).calls).toEqual([{method:"GET",path:"/app"}]);
  });
  it("refuses an expired reserved admission before any authenticated API call", async () => {
    await seed(120);
    const id = await nativeWorkflowId(request);
    const inspect = await introspectWorkflowInstance(env.NATIVE_WORKFLOW, id);
    try {
      await env.NATIVE_WORKFLOW.create({ id, params: { request, policy } });
      await inspect.waitForStatus("errored");
      expect((await apiCalls()).calls).toEqual([]);
      expect(await env.RUNS_METADATA.prepare("SELECT state FROM native_dispatches WHERE repo=? AND nonce=?")
        .bind(request.repo, request.nonce).first("state")).toBe("reserved");
    } finally { await inspect.dispose(); }
  });
  it("refuses a conflicting instance identity before App calls or durable admission", async () => {
    const id = `native-${"0".repeat(64)}`;
    const inspect = await introspectWorkflowInstance(env.NATIVE_WORKFLOW, id);
    try {
      await env.NATIVE_WORKFLOW.create({ id, params: { request, policy } });
      await inspect.waitForStatus("errored");
      expect((await apiCalls()).calls).toEqual([]);
      expect(await env.RUNS_METADATA.prepare("SELECT nonce FROM native_dispatches").all()).toMatchObject({ results: [] });
    } finally { await inspect.dispose(); }
  });
  it("keeps authentic executor failure as an errored Workflow with metadata-only checkpoints", async () => {
    const id = await nativeWorkflowId(request);
    const inspect = await introspectWorkflowInstance(env.NATIVE_WORKFLOW, id);
    try {
      await env.NATIVE_WORKFLOW.create({ id, params: { request, policy } });
      await inspect.waitForStatus("errored");
      const checkpoint = await inspect.waitForStepResult({ name: "native advance 0" });
      expect(checkpoint).toMatchObject({ checkpoint: { _tag: "Failed", runId: 123, runAttempt: 1, conclusion: "cancelled", deadlineAt: expect.any(Number) }, nextPollAt: null });
      for (const forbidden of ["fixture-native-installation-token", "Bearer", "receipt", "files", "PRIVATE KEY"])
        expect(JSON.stringify(checkpoint)).not.toContain(forbidden);
      expect((await env.RUNS_STORAGE.list({ prefix: "native-results/" })).objects).toEqual([]);
      expect((await apiCalls()).calls.map(call=>call.path)).toEqual(["/app", "/repos/owner/context/installation",
        "/app/installations/77/access_tokens", "/repos/owner/context/actions/workflows/native-windows.yml/dispatches",
        "/repos/owner/context/actions/workflows/native-windows.yml/runs", "/repos/owner/context/actions/runs/123/attempts/1"]);
    } finally { await inspect.dispose(); }
  });
  it("admits the same configured policy when its serialized property order changes", async () => {
    const id = await nativeWorkflowId(request);
    const inspect = await introspectWorkflowInstance(env.NATIVE_WORKFLOW, id);
    const reordered = { pollIntervalSec: policy.pollIntervalSec, timeoutSec: policy.timeoutSec,
      executor_ref: policy.executor_ref, repo: policy.repo };
    try {
      await env.NATIVE_WORKFLOW.create({ id, params: { request, policy: reordered } });
      await inspect.waitForStatus("errored");
      expect(await inspect.waitForStepResult({ name: "native advance 0" })).toMatchObject({
        checkpoint: { _tag: "Failed", conclusion: "cancelled" }, nextPollAt: null,
      });
      expect((await apiCalls()).calls.filter(call => call.method === "POST" && call.path.endsWith("/dispatches"))).toHaveLength(1);
    } finally { await inspect.dispose(); }
  });
  it("polls an accepted lost POST and publishes only verified archive metadata through the actual class", async () => {
    await env.NATIVE_FIXTURE_CONTROL.fetch("https://fixture.test/reset?success=1&lost=1");
    const id = await nativeWorkflowId(request);
    const inspect = await introspectWorkflowInstance(env.NATIVE_WORKFLOW, id);
    try {
      await inspect.modify(async modifier => { await modifier.disableSleeps(); });
      const instance = await env.NATIVE_WORKFLOW.create({ id, params: { request, policy } });
      await inspect.waitForStatus("complete");
      const pending = await inspect.waitForStepResult({ name: "native advance 0" });
      expect(pending).toMatchObject({ checkpoint: { _tag: "Running", runId: 123, runAttempt: 1, status: "in_progress" },
        nextPollAt: expect.any(Number) });
      const published = await inspect.getOutput();
      expect(published).toMatchObject({ _tag: "Published", runId: 123, runAttempt: 1, manifestKey: expect.any(String) });
      const output = published as { manifestKey: string; admittedAt: number; deadlineAt: number };
      expect(output.deadlineAt).toBe(output.admittedAt + policy.timeoutSec);
      const manifest = await env.RUNS_STORAGE.get(output.manifestKey);
      expect(await manifest!.json()).toMatchObject({ receipt: { exit_code: 0, run_id: "123", run_attempt: "1" } });
      const { mode: _mode, profile: _profile, ...readerRequest } = request;
      const file = await Effect.runPromise(makeNativeResultR2(env.RUNS_STORAGE, "native-controller[bot]")
        .readFile({ version: 1, ...readerRequest, expires_at: Math.floor(Date.now()/1000)+600 }, "command.log", Math.floor(Date.now()/1000)));
      expect(await new Response(file.body).text()).toBe("verified native Workflow command\n");
      for (const forbidden of ["fixture-native-installation-token", "Bearer", "receipt", "files", "verified native Workflow command", "PRIVATE KEY"])
        expect(JSON.stringify(published)).not.toContain(forbidden);
      const paths = (await apiCalls()).calls;
      expect(paths.filter(call => call.method === "POST" && call.path.endsWith("/dispatches"))).toHaveLength(1);
      expect(paths.filter(call => call.path === "/bytes")).toHaveLength(1);
      expect(paths.filter(call => call.path === "/app")).toHaveLength(2);
      // Re-observing the same completed durable instance uses its retained output, without another advance.
      expect((await (await env.NATIVE_WORKFLOW.get(instance.id)).status()).status).toBe("complete");
      expect(await inspect.getOutput()).toEqual(published);
      expect((await apiCalls()).calls).toEqual(paths);
    } finally { await inspect.dispose(); }
  });
  it("re-observes a pending instance and refuses its next advance at the immutable deadline before authentication", async () => {
    await env.NATIVE_FIXTURE_CONTROL.fetch("https://fixture.test/reset?success=1&lost=1");
    await seed(55);
    const id = await nativeWorkflowId(request);
    const inspect = await introspectWorkflowInstance(env.NATIVE_WORKFLOW, id);
    try {
      const instance = await env.NATIVE_WORKFLOW.create({ id, params: { request, policy } });
      const first = await inspect.waitForStepResult({ name: "native advance 0" });
      expect(await inspect.waitForStepResult({ name: "native advance 0" })).toEqual(first);
      const pending = first as { checkpoint: { admittedAt: number; deadlineAt: number }; nextPollAt: number };
      expect(pending.nextPollAt).toBe(pending.checkpoint.deadlineAt);
      expect(pending.nextPollAt).toBe(pending.checkpoint.admittedAt + policy.timeoutSec);
      expect((await (await env.NATIVE_WORKFLOW.get(instance.id)).status()).status).not.toBe("complete");
      const calls = (await apiCalls()).calls;
      expect((await apiCalls()).calls.filter(call => call.method === "POST" && call.path.endsWith("/dispatches"))).toHaveLength(1);
      await inspect.waitForStatus("errored");
      expect(await inspect.waitForStepResult({ name: "native advance 0" })).toEqual(first);
      expect((await apiCalls()).calls).toEqual(calls);
      expect((await env.RUNS_STORAGE.list({ prefix: "native-results/" })).objects).toEqual([]);
    } finally { await inspect.dispose(); }
  }, 10_000);
});
