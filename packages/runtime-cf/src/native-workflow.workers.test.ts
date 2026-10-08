import { env, introspectWorkflowInstance, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
const nativeWorkflowId = async (request: unknown) => (await SELF.fetch(new Request("https://fixture.test/native-id", {
  method: "POST", body: JSON.stringify(request),
}))).text();

const request = { repo: "owner/context", head: "1".repeat(40), base: "2".repeat(40), executor_ref: "3".repeat(40),
  nonce: "native-0123456789abcdef", target: "aarch64-pc-windows-msvc" as const, mode: "gate" as const, profile: "" as const,
  command_sha256: "e964c83ffcc2427c138b484a6fc61f7ebcf70b59186899176e48da89516bb2da" };
const policy = { repo: request.repo, executor_ref: request.executor_ref, timeoutSec: 60, pollIntervalSec: 30 };
const apiCalls = async () => (await env.NATIVE_FIXTURE_CONTROL.fetch("https://fixture.test/snapshot")).json<{calls: {method:string;path:string}[]}>();
const seed = async (secondsAgo: number, nonce = request.nonce) => {
  await env.RUNS_METADATA.prepare(`INSERT INTO native_dispatches
    (repo,nonce,request_json,controller_app_id,controller_login,state,admitted_at,timeout_sec,deadline_at)
    VALUES(?,?,?,?,?,'reserved',unixepoch('now')-?,60,unixepoch('now')-?+60)`)
    .bind(request.repo, nonce, JSON.stringify({ ...request, nonce }), 42, "native-controller[bot]", secondsAgo, secondsAgo).run();
};

beforeEach(async () => { await env.NATIVE_FIXTURE_CONTROL.fetch("https://fixture.test/reset"); });

describe("production NativeWorkflow with actual local Workflow and D1 bindings", () => {
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
});
