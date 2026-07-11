// Tests for the `GET /v1/browser/cdp` CDP-proxy route — the guard paths that
// don't need a live `BROWSER` binding or a real WebSocket upgrade. The happy
// path (acquire → upgrade → pipe) is exercised end-to-end by the cdp-acceptance
// run against the deployed binding, not here.

import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { handleRequest } from "../router";

const baseEnv = (over: Partial<Env> = {}): Env =>
  ({
    HMAC_SECRET: "x",
    BROWSER_CDP_API_TOKEN: "secret-token",
    // A minimal Fetcher stand-in; the guard paths return before it's used.
    BROWSER: { fetch: async () => new Response(null) } as unknown as Fetcher,
    ...over,
  }) as Env;

const wsReq = (url: string, headers: Record<string, string> = {}): Request =>
  new Request(url, { headers: { upgrade: "websocket", ...headers } });

describe("GET /v1/browser/cdp", () => {
  it("405s a non-GET method", async () => {
    const res = await handleRequest(
      new Request("https://d/v1/browser/cdp", { method: "POST" }),
      baseEnv(),
    );
    expect(res.status).toBe(405);
  });

  it("426s when the request is not a websocket upgrade", async () => {
    const res = await handleRequest(
      new Request("https://d/v1/browser/cdp"),
      baseEnv(),
    );
    expect(res.status).toBe(426);
  });

  it("503s when the BROWSER binding is absent", async () => {
    const res = await handleRequest(
      wsReq("https://d/v1/browser/cdp"),
      baseEnv({ BROWSER: undefined }),
    );
    expect(res.status).toBe(503);
  });

  it("401s when no token is supplied", async () => {
    const res = await handleRequest(wsReq("https://d/v1/browser/cdp"), baseEnv());
    expect(res.status).toBe(401);
  });

  it("401s on a wrong bearer token", async () => {
    const res = await handleRequest(
      wsReq("https://d/v1/browser/cdp", { authorization: "Bearer nope" }),
      baseEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("401s on a wrong ?token query param", async () => {
    const res = await handleRequest(
      wsReq("https://d/v1/browser/cdp?token=nope"),
      baseEnv(),
    );
    expect(res.status).toBe(401);
  });
});
