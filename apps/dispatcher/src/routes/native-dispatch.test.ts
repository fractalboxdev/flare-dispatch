import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "../router";
import { sign } from "../hmac";
import { makeFakeD1, makeFakeEnv, makeFakeR2, makeFakeWorkflow } from "../test-helpers";

const request = { repo:"owner/context",head:"1".repeat(40),base:"2".repeat(40),executor_ref:"3".repeat(40),
  nonce:"native-0123456789abcdef",target:"aarch64-pc-windows-msvc",mode:"gate",profile:"",
  command_sha256:"e964c83ffcc2427c138b484a6fc61f7ebcf70b59186899176e48da89516bb2da" };
const policy = {repo:request.repo,executor_ref:request.executor_ref,timeoutSec:3600,pollIntervalSec:30};
const key="fixture-native-dispatch-key";
const open=()=>{
  const workflow=makeFakeWorkflow();
  const env={...makeFakeEnv({hmacSecret:key,githubAppId:"42",workflow:makeFakeWorkflow(),storage:makeFakeR2(),metadata:makeFakeD1()}),
    NATIVE_WORKFLOW:workflow.binding,NATIVE_EXECUTION_POLICY:JSON.stringify(policy),GITHUB_APP_PRIVATE_KEY:"fixture-key-never-read-by-trigger"};
  const db=vi.spyOn(env.RUNS_METADATA,"prepare");
  return {env,workflow,db};
};
const post=async(value:unknown,valid=true)=>{
  const text=JSON.stringify(value),bytes=new TextEncoder().encode(text);
  return new Request("https://worker.test/v1/native-runs",{method:"POST",body:bytes,
    headers:{"content-type":"application/json","x-flaredispatch-signature":valid ? await sign(key,bytes) : "sha256=invalid"}});
};
describe("authenticated native execution trigger",()=>{
  it("creates one request-derived native instance with only the admitted request and server policy",async()=>{
    const f=open(); const response=await handleRequest(await post(request),f.env);
    expect(response.status).toBe(202);expect(f.workflow.calls).toHaveLength(1);expect(f.db).not.toHaveBeenCalled();
    const created=f.workflow.calls[0]!;
    expect(created.params).toEqual({request,policy});expect(created.id).toMatch(/^native-[0-9a-f]{64}$/);
    expect(await response.json()).toEqual({id:created.id,status:"accepted"});
    expect(JSON.stringify(created)).not.toContain(key);expect(JSON.stringify(created)).not.toContain("fixture-key-never-read");
  });
  it.each([{repo:"other/context"},{executor_ref:"4".repeat(40)}])("refuses configured identity substitution before admission %j",async(fields)=>{
    const f=open(); const response=await handleRequest(await post({...request,...fields}),f.env);
    expect(response.status).toBe(403);expect(f.workflow.calls).toHaveLength(0);expect(f.db).not.toHaveBeenCalled();
  });
  it("refuses invalid HMAC before native instance creation",async()=>{
    const f=open();expect((await handleRequest(await post(request,false),f.env)).status).toBe(401);
    expect(f.workflow.calls).toHaveLength(0);expect(f.db).not.toHaveBeenCalled();
  });
  it.each([{token:"fixture-do-not-reflect"},{padding:"x".repeat(4096)}])("refuses excess or oversized payload before admission",async(fields)=>{
    const f=open();const response=await handleRequest(await post({...request,...fields}),f.env);
    expect(response.status).toBe("padding" in fields ? 413 : 400);
    expect(await response.text()).not.toContain("fixture-do-not-reflect");
    expect(f.workflow.calls).toHaveLength(0);expect(f.db).not.toHaveBeenCalled();
  });
  it("refuses absent policy or native binding without creating a generic container instance",async()=>{
    const f=open();const {NATIVE_EXECUTION_POLICY:_policy,...noPolicy}=f.env;
    expect((await handleRequest(await post(request),noPolicy)).status).toBe(503);
    const {NATIVE_WORKFLOW:_workflow,...noWorkflow}=f.env;
    expect((await handleRequest(await post(request),noWorkflow)).status).toBe(503);
    expect(f.workflow.calls).toHaveLength(0);expect(f.db).not.toHaveBeenCalled();
  });
  it.each(["042","4e1","9007199254740992"])("refuses malformed configured App identity %s before creating an instance",async appId=>{
    const f=open();const response=await handleRequest(await post(request),{...f.env,GITHUB_APP_ID:appId});
    expect(response.status).toBe(503);expect(f.workflow.calls).toHaveLength(0);expect(f.db).not.toHaveBeenCalled();
  });
  it.each(["running", "complete", "errored", "terminated", "unknown"])("reconciles an ambiguous create only through the same instance: %s", async status => {
    const f = open();
    const create = vi.spyOn(f.workflow.binding, "create").mockRejectedValue(new Error("fixture acknowledgement lost"));
    const seen: string[] = [];
    const get = vi.spyOn(f.workflow.binding, "get").mockImplementation(async id => {
      seen.push(id);
      return { id, status: async () => ({ status }) } as Awaited<ReturnType<typeof f.workflow.binding.get>>;
    });
    const response = await handleRequest(await post(request), f.env);
    expect(response.status).toBe(status === "unknown" ? 503 : status === "errored" || status === "terminated" ? 409 : 202);
    expect(create).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([create.mock.calls[0]![0]!.id]); expect(f.db).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("fixture acknowledgement lost");
  });
  it("refuses a foreign instance returned by ambiguous create observation", async () => {
    const f = open();
    const create = vi.spyOn(f.workflow.binding, "create").mockRejectedValue(new Error("fixture acknowledgement lost"));
    vi.spyOn(f.workflow.binding, "get").mockImplementation(async () => {
      return { id: "foreign-instance", status: async () => ({status:"running"}) } as Awaited<ReturnType<typeof f.workflow.binding.get>>;
    });
    expect((await handleRequest(await post(request), f.env)).status).toBe(503);
    expect(create).toHaveBeenCalledTimes(1); expect(f.db).not.toHaveBeenCalled();
  });
  it("refuses signed invalid UTF8 and query claims before creating an instance", async () => {
    const f = open(), bytes = new Uint8Array([0xff]);
    const invalid = new Request("https://worker.test/v1/native-runs", { method:"POST", body:bytes,
      headers:{ "x-flaredispatch-signature":await sign(key,bytes) } });
    expect((await handleRequest(invalid,f.env)).status).toBe(400);
    const query = await post(request);
    expect((await handleRequest(new Request(`${query.url}?token=fixture-forbidden`,query),f.env)).status).toBe(400);
    expect(f.workflow.calls).toHaveLength(0);expect(f.db).not.toHaveBeenCalled();
  });
});
