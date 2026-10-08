import { Effect, Redacted } from "effect";
import { describe, expect, it, vi } from "vitest";
import * as native from "./native";

const now = Date.parse("2026-10-08T00:00:00Z") / 1000;
const options = { appId:"42", appJwt:"fixture-app-jwt", repo:"owner/context" };
const installation = () => ({ id:77, app_id:42, account:{login:"owner"},
  suspended_at:null, permissions:{actions:"write", metadata:"read", checks:"write"} });
const grant = () => ({ token:"fixture.ephemeral.token", expires_at:"2026-10-08T01:00:00Z",
  repository_selection:"selected", repositories:[{name:"context",full_name:"owner/context"}],
  permissions:{actions:"write",metadata:"read"} });
const read = (fetchImpl:typeof fetch, at:number = now, override = {}) =>
  Effect.runPromise((native as unknown as {readNativeGithubContext:(o:unknown,n:number)=>Effect.Effect<{
    token:Redacted.Redacted<string>; controller:{appId:number;actorLogin:string};installationId:number;
    expiresAt:number;repo:string},unknown>}).readNativeGithubContext({...options,...override,fetchImpl},at));
const fixture = (install:unknown = installation(), token:unknown = grant()) => {
  const fetchImpl = vi.fn(async (url:string | URL | Request, init?:RequestInit) => {
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-app-jwt");
    if (String(url).endsWith("/app")) return Response.json({id:42,slug:"native-controller"});
    if (String(url).endsWith("/repos/owner/context/installation")) return Response.json(install);
    expect(String(url)).toBe("https://api.github.com/app/installations/77/access_tokens");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({repositories:["context"],permissions:{actions:"write",metadata:"read"}});
    return Response.json(token,{status:201});
  });
  return fetchImpl;
};

describe("ephemeral native GitHub context", () => {
  it("authenticates the App and mints exactly one repository grant without a shared cache", async () => {
    const fetchImpl = fixture();
    const result = await read(fetchImpl);
    expect(result.controller).toEqual({appId:42,actorLogin:"native-controller[bot]"});
    expect(result.installationId).toBe(77);
    expect(result.repo).toBe(options.repo);
    expect(result.expiresAt).toBe(now+3600);
    expect(Redacted.value(result.token)).toBe("fixture.ephemeral.token");
    expect(JSON.stringify(result)).not.toContain("fixture.ephemeral.token");
    await read(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });
  it("refuses invalid time or repository before authentication", async () => {
    const fetchImpl=fixture();
    for (const at of [0,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER])
      await expect(read(fetchImpl,at)).rejects.toThrow();
    await expect(read(fetchImpl,now,{repo:"owner/context/other"})).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects a foreign authenticated App before installation access", async () => {
    const fetchImpl=vi.fn(async()=>Response.json({id:43,slug:"foreign-controller"}));
    await expect(read(fetchImpl)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("does not reuse another App's grant for the same repository and installation", async () => {
    for (const id of [42,43]) {
      const jwt=`fixture-app-${id}`;
      const fetchImpl=vi.fn(async(url:string | URL | Request,init?:RequestInit)=> {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${jwt}`);
        if(String(url).endsWith("/app"))return Response.json({id,slug:`controller-${id}`});
        if(String(url).endsWith("/installation"))return Response.json({...installation(),app_id:id});
        return Response.json({...grant(),token:`app-${id}-token`},{status:201});
      });
      const result=await read(fetchImpl,now,{appId:String(id),appJwt:jwt});
      expect(result.controller.appId).toBe(id);
      expect(Redacted.value(result.token)).toBe(`app-${id}-token`);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    }
  });
  it.each([
    {...installation(),app_id:43}, {...installation(),id:0}, {...installation(),account:{login:"foreign"}},
    {...installation(),suspended_at:"2026-10-07T00:00:00Z"},
    {...installation(),permissions:{actions:"read"}},
  ])("refuses foreign, suspended or insufficient installations before minting", async (value) => {
    const fetchImpl=fixture(value);
    await expect(read(fetchImpl)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it.each([
    {...grant(),repository_selection:"all"}, {...grant(),repositories:[]},
    {...grant(),repositories:[...grant().repositories,{name:"other",full_name:"owner/other"}]},
    {...grant(),repositories:[{name:"context",full_name:"foreign/context"}]},
    {...grant(),permissions:{actions:"read"}}, {...grant(),permissions:{actions:"write",contents:"read"}},
    {...grant(),expires_at:"2026-10-08T00:00:00Z"}, {...grant(),expires_at:"2026-02-30T00:00:00Z"},
    {...grant(),token:"unsafe\r\nheader"}, {...grant(),token:""},
  ])("refuses broad or malformed minted grants without exposing their token", async (value) => {
    await expect(read(fixture(installation(),value))).rejects.toThrow();
  });
  it("accepts omission of automatic metadata permission from the response", async () => {
    await expect(read(fixture(installation(),{...grant(),permissions:{actions:"write"}}))).resolves.toBeDefined();
  });
  it("refuses fractional expiry before returning an ephemeral context", async () => {
    await expect(read(fixture(installation(),{...grant(),expires_at:"2026-10-08T01:00:00.123Z"}))).rejects.toThrow();
  });
  it("rejects oversized and non-UTF8 POST responses through the shared receiver", async () => {
    for (const bytes of [new Uint8Array(65537),new Uint8Array([255])]) {
      const ordinary=fixture();
      const fetchImpl=vi.fn(async (url:string | URL | Request,init?:RequestInit) =>
        String(url).endsWith("/access_tokens") ? new Response(bytes,{status:201}) : ordinary(url,init));
      await expect(read(fetchImpl)).rejects.toThrow();
    }
  });
});
