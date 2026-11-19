import { describe, expect, it, vi } from "vitest";
import { parseNativeControllerAppId, readNativeControllerIdentity } from "./index";

const opts = { appId: "123", appJwt: "fixture-app-jwt" };
const response = (body: unknown) => Response.json(body);

describe("native controller identity", () => {
  it("admits only canonical safe decimal App configuration for local and authenticated lookup",()=>{
    expect(parseNativeControllerAppId("123")).toBe(123);
    for(const value of [123, null, {toString:()=>"123"}, "", "00123", " 123", "1e2", "9007199254740992"])
      expect(()=>parseNativeControllerAppId(value)).toThrow();
  });
  it("reads the authenticated configured App rather than a caller's public slug", async () => {
    const fetchImpl = vi.fn(async () => response({ id: 123, slug: "fixture-controller", owner: {} }));
    expect(await readNativeControllerIdentity({ ...opts, fetchImpl })).toEqual({
      appId: 123, actorLogin: "fixture-controller[bot]",
    });
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/app");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-app-jwt");
  });

  it("refuses mismatched or malformed authenticated identity", async () => {
    for (const body of [
      { id: 124, slug: "fixture-controller" }, { id: "123", slug: "fixture-controller" },
      { id: 123 }, { id: 123, slug: "" }, { id: 123, slug: "other[bot]" },
      { id: 123, slug: "owner/controller" }, null,
    ]) {
      await expect(readNativeControllerIdentity({ ...opts, fetchImpl: async () => response(body) }))
        .rejects.toMatchObject({ name: "GithubApiError" });
    }
  });

  it("refuses unconfigured identity before any authenticated request", async () => {
    const fetchImpl = vi.fn(async () => response({ id: 123, slug: "fixture-controller" }));
    for (const changed of [{ appId: "" }, { appId: "00123" }, { appId: "1.2" }, { appJwt: "" }]) {
      await expect(readNativeControllerIdentity({ ...opts, ...changed, fetchImpl })).rejects.toMatchObject({
        name: "GithubApiError",
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds and sanitizes failed evidence without retrying or returning response secrets", async () => {
    for (const makeResponse of [
      () => new Response("fixture-sensitive-response", { status: 401 }),
      () => new Response("fixture-sensitive-response", { status: 302, headers: { location: "https://other.example/app" } }),
      () => new Response("x".repeat(65_537)),
      () => new Response("not-json"),
    ]) {
      const fetchImpl = vi.fn(async () => makeResponse());
      await expect(readNativeControllerIdentity({ ...opts, fetchImpl })).rejects.toMatchObject({
        name: "GithubApiError", body: "",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});
