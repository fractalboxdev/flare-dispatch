import { env } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { type NativeReadBinding, type NativeRequest, NativeReceiptRefused } from "@fractalboxdev/flare-dispatch-core";
import * as dispatch from "./native-dispatch-d1";

const controller = { appId:123, actorLogin:"native-controller[bot]" };
const request: NativeRequest = {
  repo:"owner/context", head:"1".repeat(40), base:"2".repeat(40), executor_ref:"3".repeat(40),
  nonce:"native-owner-0123456789abcdef", target:"aarch64-pc-windows-msvc", mode:"gate", profile:"",
  command_sha256:"e964c83ffcc2427c138b484a6fc61f7ebcf70b59186899176e48da89516bb2da",
};
const now = Math.floor(Date.now() / 1000);
const binding: NativeReadBinding = { version:1, repo:request.repo, head:request.head, base:request.base,
  nonce:request.nonce, target:request.target, command_sha256:request.command_sha256,
  executor_ref:request.executor_ref, expires_at:now + 300 };
type Reader = (db: Pick<D1Database, "prepare">, binding: unknown, appId: number, now: number) =>
  Effect.Effect<{ request:NativeRequest; controllerLogin:string; runId:number; runAttempt:number }, NativeReceiptRefused>;
const readOwner: Reader = (...args) => (dispatch as unknown as { readNativeResultOwnerD1:Reader }).readNativeResultOwnerD1(...args);
const run = () => ({ repo:request.repo, runId:456, runAttempt:2, event:"workflow_dispatch",
  executorRef:request.executor_ref, workflowPath:".github/workflows/native-windows.yml",
  runName:`native-${request.nonce}`, actorLogin:controller.actorLogin, actorType:"Bot", createdAt:new Date().toISOString() });
const start = async (bind = true) => {
  const jobs = dispatch.makeNativeDispatchD1(env.RUNS_METADATA, controller, {
    dispatch:() => Effect.void, listRuns:() => Effect.succeed([run()]), readRun:() => Effect.succeed(run()),
  });
  await Effect.runPromise(jobs.start(request));
  if (bind) await Effect.runPromise(jobs.reconcile(request));
};

describe("native result authority from real D1", () => {
  it("admits only the persisted controller-bound full request after authentic dispatch reconciliation", async () => {
    await start();
    expect(await Effect.runPromise(readOwner(env.RUNS_METADATA, binding, controller.appId, now)))
      .toEqual({ request, controllerLogin:controller.actorLogin, runId:456, runAttempt:2 });
  });

  it("refuses expired or malformed reader identity before touching D1", async () => {
    let queries = 0;
    const forbidden = { prepare:() => { queries++; throw new Error("fixture DB must not be read"); } };
    for (const raw of [{ ...binding, expires_at:now }, { ...binding, version:2 }, { ...binding, extra:"forged" }])
      await expect(Effect.runPromise(readOwner(forbidden, raw, controller.appId, now))).rejects.toThrow();
    expect(queries).toBe(0);
  });

  it("refuses every foreign binding field and foreign configured owner", async () => {
    await start();
    for (const patch of [
      { repo:"another/context" }, { nonce:"native-another-0123456789" }, { head:"4".repeat(40) },
      { base:"4".repeat(40) }, { executor_ref:"4".repeat(40) }, { command_sha256:"4".repeat(64) },
      { target:"x86_64-pc-windows-msvc" },
    ]) await expect(Effect.runPromise(readOwner(env.RUNS_METADATA, { ...binding, ...patch }, controller.appId, now))).rejects.toThrow();
    for (const appId of [124, 0, -1, 1.5, Infinity])
      await expect(Effect.runPromise(readOwner(env.RUNS_METADATA, binding, appId, now))).rejects.toThrow();
  });

  it("refuses unbound intent, malformed stored identity and non-bot ownership", async () => {
    await start(false);
    await expect(Effect.runPromise(readOwner(env.RUNS_METADATA, binding, controller.appId, now))).rejects.toThrow();
    await env.RUNS_METADATA.prepare("UPDATE native_dispatches SET state='bound', run_id=456, run_attempt=2").run();
    for (const text of ["{malformed", JSON.stringify({ ...request, profile:"unexpected" }), JSON.stringify({ ...request, nonce:"native-foreign-0123456789" })]) {
      await env.RUNS_METADATA.prepare("UPDATE native_dispatches SET request_json=?").bind(text).run();
      await expect(Effect.runPromise(readOwner(env.RUNS_METADATA, binding, controller.appId, now))).rejects.toThrow();
    }
    await env.RUNS_METADATA.prepare("UPDATE native_dispatches SET request_json=?, controller_login='human'").bind(JSON.stringify(request)).run();
    await expect(Effect.runPromise(readOwner(env.RUNS_METADATA, binding, controller.appId, now))).rejects.toThrow();
  });

  it("refuses legacy absent admission time and unsafe durable run identity", async () => {
    await env.RUNS_METADATA.prepare(`INSERT INTO native_dispatches
      (repo,nonce,request_json,controller_app_id,controller_login,state,run_id,run_attempt)
      VALUES (?,?,?,?,?,'bound',456,2)`).bind(request.repo, request.nonce, JSON.stringify(request), controller.appId, controller.actorLogin).run();
    await expect(Effect.runPromise(readOwner(env.RUNS_METADATA, binding, controller.appId, now))).rejects.toThrow();
    await env.RUNS_METADATA.prepare("DELETE FROM native_dispatches").run();
    await start();
    for (const id of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await env.RUNS_METADATA.prepare("UPDATE native_dispatches SET run_id=?").bind(id).run();
      await expect(Effect.runPromise(readOwner(env.RUNS_METADATA, binding, controller.appId, now))).rejects.toThrow();
      await env.RUNS_METADATA.prepare("UPDATE native_dispatches SET run_id=456, run_attempt=?").bind(id).run();
      await expect(Effect.runPromise(readOwner(env.RUNS_METADATA, binding, controller.appId, now))).rejects.toThrow();
    }
  });
});
