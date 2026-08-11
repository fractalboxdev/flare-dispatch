// `invokeBedrockViaAiGateway` tests — the live SigV4 + Bedrock target is not
// reachable from `vitest` (signing requires deterministic clock + the gateway
// path needs a real account), so we inject `fetchImpl` and assert what the
// helper SENDS (URL, headers, body) and what it MAPS from a stubbed response.

import { describe, expect, it } from "vitest";
import {
  type AnthropicTool,
  invokeBedrockViaAiGateway,
} from "./bedrock-invoke.js";

const creds = {
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret",
  sessionToken: "sess",
};

const stubFetch =
  (
    onRequest: (url: string, init: RequestInit) => Response,
  ): typeof fetch =>
  async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    return onRequest(url, init ?? {});
  };

describe("invokeBedrockViaAiGateway", () => {
  it("posts to the AI Gateway aws-bedrock URL with an Anthropic body and SigV4 headers", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody: unknown = null;
    const fetchImpl = stubFetch((url, init) => {
      seenUrl = url;
      seenHeaders = init.headers as Record<string, string>;
      seenBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 1 },
        }),
        { status: 200 },
      );
    });

    const result = await invokeBedrockViaAiGateway({
      creds,
      region: "us-east-1",
      modelId: "us.anthropic.claude-opus-4-7-v1",
      system: "you are helpful",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      cloudflareAccountId: "acct123",
      gatewayId: "gw1",
      fetchImpl,
    });

    expect(seenUrl).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct123/gw1/aws-bedrock/bedrock-runtime/us-east-1/model/us.anthropic.claude-opus-4-7-v1/invoke",
    );
    expect(seenHeaders["host"]).toBe("bedrock-runtime.us-east-1.amazonaws.com");
    expect(seenHeaders["x-amz-security-token"]).toBe("sess");
    expect(seenHeaders["authorization"]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-east-1\/bedrock\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
    );
    expect(seenBody).toEqual({
      anthropic_version: "bedrock-2023-05-31",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
      system: "you are helpful",
    });

    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.inputTokens).toBe(5);
    expect(result.outputTokens).toBe(1);
  });

  it("forwards tools + tool_choice in the Anthropic body when provided", async () => {
    let seenBody: Record<string, unknown> = {};
    const fetchImpl = stubFetch((_url, init) => {
      seenBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "click",
              input: { target: "#go" },
            },
          ],
          stop_reason: "tool_use",
        }),
        { status: 200 },
      );
    });

    const tools: ReadonlyArray<AnthropicTool> = [
      {
        name: "click",
        description: "click an element",
        input_schema: { type: "object", properties: {} },
      },
    ];
    const result = await invokeBedrockViaAiGateway({
      creds,
      region: "us-east-1",
      modelId: "id",
      messages: [{ role: "user", content: "go" }],
      tools,
      toolChoice: { type: "any" },
      cloudflareAccountId: "a",
      gatewayId: "g",
      fetchImpl,
    });

    expect(seenBody["tools"]).toEqual(tools);
    expect(seenBody["tool_choice"]).toEqual({ type: "any" });
    expect(result.content[0]).toEqual({
      type: "tool_use",
      id: "toolu_1",
      name: "click",
      input: { target: "#go" },
    });
    expect(result.stopReason).toBe("tool_use");
  });

  it("adds cf-aig-authorization when gatewayAuthToken is provided", async () => {
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = stubFetch((_url, init) => {
      seenHeaders = init.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ content: [], stop_reason: "end_turn" }),
        { status: 200 },
      );
    });

    await invokeBedrockViaAiGateway({
      creds,
      region: "us-east-1",
      modelId: "id",
      messages: [{ role: "user", content: "x" }],
      cloudflareAccountId: "a",
      gatewayId: "g",
      gatewayAuthToken: "aig-secret",
      fetchImpl,
    });

    expect(seenHeaders["cf-aig-authorization"]).toBe("Bearer aig-secret");
  });

  it("throws with truncated body on non-2xx", async () => {
    const fetchImpl = stubFetch(
      () =>
        new Response("internal-error", {
          status: 500,
        }),
    );
    await expect(
      invokeBedrockViaAiGateway({
        creds,
        region: "us-east-1",
        modelId: "id",
        messages: [{ role: "user", content: "x" }],
        cloudflareAccountId: "a",
        gatewayId: "g",
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 500.*internal-error/);
  });

  it("returns empty content when Bedrock omits content blocks", async () => {
    const fetchImpl = stubFetch(
      () =>
        new Response(JSON.stringify({ stop_reason: "end_turn" }), {
          status: 200,
        }),
    );
    const result = await invokeBedrockViaAiGateway({
      creds,
      region: "us-east-1",
      modelId: "id",
      messages: [{ role: "user", content: "x" }],
      cloudflareAccountId: "a",
      gatewayId: "g",
      fetchImpl,
    });
    expect(result.content).toEqual([]);
    expect(result.stopReason).toBe("end_turn");
  });
});
