// The assumption under FD-IFC-072: Effect 4.0.6's MCP server serves Streamable HTTP inside a Worker. Both transports run
// on workerd through Miniflare, each answering a real `tools/call`.
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let mf: Miniflare;

beforeAll(async () => {
  const bundle = await build({
    entryPoints: [join(import.meta.dirname, "testing/mcp-probe.fixture.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    external: ["cloudflare:*"],
  });
  mf = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.js", contents: bundle.outputFiles[0]!.text }],
    compatibilityDate: "2026-05-01",
  });
  await mf.ready;
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

const ACCEPT = "application/json, text/event-stream";

/** The JSON-RPC message of a response body, plain JSON or the `data:` line of an SSE event. */
const message = async (response: { text(): Promise<string> }) => {
  const text = await response.text();
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  return JSON.parse(data.at(-1) ?? text) as {
    result?: { content?: { text: string }[]; structuredContent?: unknown };
    error?: unknown;
  };
};

describe("MCP over Streamable HTTP on workerd", () => {
  it("FD-IFC-072: the request-scoped endpoint answers a sessionless tools/call (revision 2026-07-28)", async () => {
    const response = await mf.dispatchFetch("http://x/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: ACCEPT,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "get_verdict",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "get_verdict",
          arguments: { execution_id: "e1" },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    const reply = await message(response);
    expect(reply.error).toBeUndefined();
    expect(JSON.stringify(reply.result)).toContain('"status":"done"');
  });

  it("FD-IFC-072: the request-scoped endpoint refuses a sessionful initialize", async () => {
    const response = await mf.dispatchFetch("http://x/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("FD-IFC-072: the long-lived endpoint initializes a session and answers tools/call (revision 2025-06-18)", async () => {
    const init = await mf.dispatchFetch("http://x/mcp-session", {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      }),
    });
    expect(init.status).toBe(200);
    const session = init.headers.get("mcp-session-id");
    expect(session).not.toBeNull();
    await init.text();
    const headers = {
      "content-type": "application/json",
      accept: ACCEPT,
      "mcp-session-id": session!,
      "mcp-protocol-version": "2025-06-18",
    };
    const initialized = await mf.dispatchFetch("http://x/mcp-session", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(initialized.status).toBe(202);
    await initialized.text();
    const call = await mf.dispatchFetch("http://x/mcp-session", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_verdict", arguments: { execution_id: "e2" } },
      }),
    });
    expect(call.status).toBe(200);
    const reply = await message(call);
    expect(reply.error).toBeUndefined();
    expect(JSON.stringify(reply.result)).toContain('"status":"done"');
  });
});
