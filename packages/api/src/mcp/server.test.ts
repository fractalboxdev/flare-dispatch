import { Effect } from "effect";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  accessClaims,
  DISPATCHER,
  makeHarness,
  MEMBER,
  record,
  type Harness,
} from "../api.test-support.ts";
import { MAX_TOOL_RESULT_BYTES } from "./tools.ts";
import { mcpGroup } from "./server.ts";

let h: Harness;
beforeAll(async () => {
  h = await makeHarness([mcpGroup]);
});
beforeEach(() => {
  h.doubles.intake = (s) =>
    Effect.succeed({ _tag: "Admitted", executionId: "01JMCP", class: s.class ?? "batch" });
});

const VERSION = "2026-07-28";

const call = async (name: string, args: Record<string, unknown>, headers: Record<string, string>) =>
  h.fetch("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": VERSION,
      "mcp-method": "tools/call",
      "mcp-name": name,
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });

interface ToolReply {
  readonly isError: boolean;
  readonly value: Record<string, unknown>;
  readonly bytes: number;
}

const reply = async (response: Response): Promise<ToolReply> => {
  const text = await response.text();
  const data = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  const message = JSON.parse(data.at(-1) ?? text) as {
    result?: { isError?: boolean; content: { text: string }[]; structuredContent?: unknown };
    error?: unknown;
  };
  if (message.result === undefined)
    throw new Error(`protocol error: ${JSON.stringify(message.error)}`);
  const content = message.result.content[0]?.text ?? "{}";
  return {
    isError: message.result.isError === true,
    value: JSON.parse(content) as Record<string, unknown>,
    bytes: new TextEncoder().encode(content).byteLength,
  };
};

const as = async (email: string) => ({
  "cf-access-jwt-assertion": await h.access.sign(accessClaims(email)),
});

describe("/mcp", () => {
  it("FD-IFC-073: a request with no valid Access JWT answers 401 unauthenticated", async () => {
    const missing = await call("get_verdict", { execution_id: "x" }, {});
    expect(missing.status).toBe(401);
    expect(((await missing.json()) as { error: string }).error).toBe("unauthenticated");
    const forged = await call(
      "get_verdict",
      { execution_id: "x" },
      { "cf-access-jwt-assertion": "a.b.c" },
    );
    expect(forged.status).toBe(401);
  });

  it("FD-IFC-072: the server answers get_verdict over Streamable HTTP", async () => {
    h.doubles.executions.set(
      "01JV",
      record({ execution_id: "01JV", verdict: "success", conclusion: "success" }),
    );
    const result = await reply(
      await call("get_verdict", { execution_id: "01JV" }, await as(MEMBER)),
    );
    expect(result.isError).toBe(false);
    expect(result.value).toMatchObject({
      execution_id: "01JV",
      status: "done",
      verdict: "success",
    });
  });

  it("FD-IFC-074: dispatch keeps the dispatch route's identity rule and submits through intake as an mcp trigger", async () => {
    const args = { run: "check", repo: "acme/widgets", sha: "a".repeat(40), inputs: {} };
    const member = await reply(await call("dispatch", args, await as(MEMBER)));
    expect(member.isError).toBe(true);
    expect(member.value["error"]).toBe("unauthenticated");
    const before = h.doubles.calls.submissions.length;
    const ok = await reply(
      await call("dispatch", { ...args, class: "batch" }, await as(DISPATCHER)),
    );
    expect(ok.isError).toBe(false);
    expect(ok.value["execution_id"]).toBe("01JMCP");
    const submission = h.doubles.calls.submissions.at(-1)!;
    expect(h.doubles.calls.submissions.length).toBe(before + 1);
    expect(submission).toMatchObject({
      trigger: "mcp",
      run: "check",
      repository: "acme/widgets",
      class: "batch",
      caller: DISPATCHER,
    });
  });

  it("FD-IFC-074: a duplicate dispatch answers the existing execution, as the route does", async () => {
    h.doubles.intake = () =>
      Effect.succeed({ _tag: "Duplicate", executionId: "01JOLD", class: "batch" });
    const result = await reply(
      await call(
        "dispatch",
        { run: "check", repo: "acme/widgets", inputs: {} },
        await as(DISPATCHER),
      ),
    );
    expect(result.value).toMatchObject({ execution_id: "01JOLD", duplicate: true });
  });

  it("FD-IFC-078: wait_seconds over 60 on get_verdict or dispatch is the invalid_wait tool error", async () => {
    const verdict = await reply(
      await call("get_verdict", { execution_id: "x", wait_seconds: 61 }, await as(MEMBER)),
    );
    expect(verdict.value["error"]).toBe("invalid_wait");
    const dispatch = await reply(
      await call(
        "dispatch",
        { run: "check", repo: "acme/widgets", inputs: {}, wait_seconds: 61 },
        await as(DISPATCHER),
      ),
    );
    expect(dispatch.value["error"]).toBe("invalid_wait");
  });

  it("FD-IFC-080: a route error is a tool error carrying its code, not a protocol error", async () => {
    const missing = await reply(
      await call("get_verdict", { execution_id: "nope" }, await as(MEMBER)),
    );
    expect(missing.isError).toBe(true);
    expect(missing.value["error"]).toBe("execution_not_found");
    h.doubles.executions.set(
      "01JRUN",
      record({ execution_id: "01JRUN", status: "running", verdict: null }),
    );
    const unfinished = await reply(
      await call("get_failure_summary", { execution_id: "01JRUN" }, await as(MEMBER)),
    );
    expect(unfinished.value["error"]).toBe("not_finished");
  });

  it("FD-IFC-079: a failure summary result stays within 16 KiB", async () => {
    h.doubles.executions.set("01JFAIL", record({ execution_id: "01JFAIL" }));
    const result = await reply(
      await call("get_failure_summary", { execution_id: "01JFAIL" }, await as(MEMBER)),
    );
    expect(result.isError).toBe(false);
    expect(result.bytes).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
  });

  it("FD-IFC-046: cancel keeps the route's rule: only the dispatcher or an operator", async () => {
    h.doubles.executions.set("01JC", record({ execution_id: "01JC", status: "running" }));
    const denied = await reply(await call("cancel", { execution_id: "01JC" }, await as(MEMBER)));
    expect(denied.value["error"]).toBe("forbidden");
    const ok = await reply(await call("cancel", { execution_id: "01JC" }, await as(DISPATCHER)));
    expect(ok.value).toMatchObject({ execution_id: "01JC", verdict: "cancelled" });
  });
});
