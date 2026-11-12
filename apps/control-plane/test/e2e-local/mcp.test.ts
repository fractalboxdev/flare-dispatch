// The dispatcher's MCP server over the deployed Worker: an agent's Streamable HTTP calls reach `/mcp` through the
// front, `dispatch` is admitted through intake as trigger `mcp` under the caller's Access identity, a device runs the
// lease, and `get_verdict` waits for the verdict.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connect,
  endStandingClaim,
  hello,
  newDevice,
  OPERATOR,
  registration,
  type Socket,
} from "../support.ts";
import { PLANE_ID, REPOSITORY, startStack, type Stack } from "./stack.ts";

const VERSION = "2026-07-28";

let stack: Stack;
let device: Socket;

beforeAll(async () => {
  stack = await startStack();
  const { identity, keys } = await newDevice();
  const enrolled = await fetch(`${stack.url}/v1/executors/register`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await stack.access(OPERATOR)) },
    body: JSON.stringify(registration("e2e-mcp-device", identity)),
  });
  expect(enrolled.status).toBe(201);
  device = await connect(stack.mf, "e2e-mcp-device", keys, PLANE_ID);
  device.send(hello("e2e-mcp-device", PLANE_ID));
  await device.next("session.welcome");
});

afterAll(async () => {
  await stack?.close();
});

/** One JSON-RPC request to `/mcp` on the sessionless revision, as an MCP client sends it. */
const rpc = async (
  method: string,
  params: Record<string, unknown>,
  identity: string | null,
  name?: string,
) =>
  fetch(`${stack.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": VERSION,
      "mcp-method": method,
      ...(name === undefined ? {} : { "mcp-name": name }),
      ...(await stack.access(identity)),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });

/** The JSON-RPC result of a Streamable HTTP answer, sent as JSON or as an event stream. */
const resultOf = async (r: Response) => {
  expect(r.status).toBe(200);
  const text = await r.text();
  const data = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  const message = JSON.parse(data.at(-1) ?? text) as { result?: unknown; error?: unknown };
  if (message.result === undefined)
    throw new Error(`protocol error: ${JSON.stringify(message.error)}`);
  return message.result as Record<string, unknown>;
};

const call = async (tool: string, args: Record<string, unknown>, identity = OPERATOR) => {
  const result = (await resultOf(
    await rpc("tools/call", { name: tool, arguments: args }, identity, tool),
  )) as { isError?: boolean; content: { text: string }[] };
  return {
    isError: result.isError === true,
    value: JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>,
  };
};

const inputs = (sha: string) => ({
  repo: `https://github.com/${REPOSITORY}`,
  sha,
  ref: "refs/heads/main",
  steps: [{ label: "test", command: "pnpm test" }],
});

let claims = 0;

/** The device claims until it holds `id`'s lease, and reports `outcome` for it. */
const settle = async (id: string, outcome: Record<string, unknown>) => {
  while (true) {
    device.send({
      type: "exec.claim",
      id: `c${++claims}`,
      free: { release: 1, required: 1, interactive: 1, batch: 1 },
    });
    const lease = await device.next("exec.lease");
    const ours = lease["execution_id"] === id;
    device.send({
      type: "exec.result",
      id: `r${claims}`,
      execution_id: lease["execution_id"],
      epoch: lease["epoch"],
      result_id: `${String(lease["execution_id"])}:${String(lease["epoch"])}`,
      outcome: ours ? outcome : { status: "cancelled", reason: "superseded" },
      usage: {},
      artifacts: [],
    });
    expect(await device.next("exec.result.ack")).toMatchObject({ status: "accepted" });
    await endStandingClaim(device);
    if (ours) return lease;
  }
};

describe("the MCP server at /mcp", () => {
  it("[FD-IFC-072] serves its four tools over Streamable HTTP through the deployed Worker", async () => {
    const listed = (await resultOf(await rpc("tools/list", {}, OPERATOR))) as {
      tools: { name: string }[];
    };
    expect(listed.tools.map((t) => t.name).sort()).toEqual(
      ["cancel", "dispatch", "get_failure_summary", "get_verdict"].sort(),
    );
    const anonymous = await rpc("tools/list", {}, null);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ error: "unauthenticated" });
    expect(stack.requests.filter((r) => r.path === "/mcp" && r.method === "POST").length).toBe(2);
  });

  it("[FD-ARCH-002] [FD-INT-062] [FD-IFC-072] a dispatch call runs as trigger mcp under the caller's identity, and get_verdict waits for its verdict", async () => {
    const sha = "6".repeat(40);
    const dispatched = await call("dispatch", {
      run: "check",
      repo: REPOSITORY,
      sha,
      inputs: inputs(sha),
    });
    expect(dispatched.isError).toBe(false);
    const id = String(dispatched.value["execution_id"]);
    // [FD-ARCH-002] The Worker wrote this intake row, so it admitted the call.
    const record = (
      await (
        await stack.mf.getD1Database("DB")
      )
        .prepare("select trigger, caller from intake_records where execution_id = ?")
        .bind(id)
        .all()
    ).results[0];
    expect(record).toEqual({ trigger: "mcp", caller: OPERATOR });

    const held = call("get_verdict", { execution_id: id, wait_seconds: 60 });
    const lease = await settle(id, { status: "success" });
    expect(lease).toMatchObject({ execution_id: id, run: "check", scope_id: REPOSITORY });
    expect(await held).toMatchObject({
      isError: false,
      value: { execution_id: id, status: "done", verdict: "success" },
    });
  });
});
