// `invokeBedrockSigned` tests — the live SigV4 + Bedrock target is not reachable
// from `vitest`, so we inject `fetchImpl` and assert what the signer SENDS (URL,
// SigV4 headers, body) and how it surfaces a non-2xx response.

import { describe, expect, it } from "vitest";
import { invokeBedrockSigned } from "./index.js";

const creds = {
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret",
  sessionToken: "sess",
};

const stubFetch =
  (onRequest: (url: string, init: RequestInit) => Response): typeof fetch =>
  async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    return onRequest(url, init ?? {});
  };

const sha256Hex = async (data: string): Promise<string> => {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(data),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

describe("invokeBedrockSigned", () => {
  it("POSTs the payload to the AI Gateway URL with SigV4 headers", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody = "";
    const payload = JSON.stringify({ hello: "world" });
    const fetchImpl = stubFetch((url, init) => {
      seenUrl = url;
      seenHeaders = init.headers as Record<string, string>;
      seenBody = init.body as string;
      return new Response("{}", { status: 200 });
    });

    const res = await invokeBedrockSigned({
      creds,
      region: "us-east-1",
      modelId: "us.anthropic.claude-opus-4-7-v1",
      payload,
      cloudflareAccountId: "acct123",
      gatewayId: "gw1",
      fetchImpl,
    });

    expect(res.ok).toBe(true);
    expect(seenUrl).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct123/gw1/aws-bedrock/bedrock-runtime/us-east-1/model/us.anthropic.claude-opus-4-7-v1/invoke",
    );
    expect(seenBody).toBe(payload);
    expect(seenHeaders["host"]).toBe("bedrock-runtime.us-east-1.amazonaws.com");
    expect(seenHeaders["x-amz-security-token"]).toBe("sess");
    // The content hash header MUST be sha256 of the exact payload bytes.
    expect(seenHeaders["x-amz-content-sha256"]).toBe(await sha256Hex(payload));
    expect(seenHeaders["authorization"]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-east-1\/bedrock\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
    );
    // No Authenticated-Gateway token unless asked for.
    expect(seenHeaders["cf-aig-authorization"]).toBeUndefined();
  });

  it("adds cf-aig-authorization when a gateway auth token is given", async () => {
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = stubFetch((_url, init) => {
      seenHeaders = init.headers as Record<string, string>;
      return new Response("{}", { status: 200 });
    });

    await invokeBedrockSigned({
      creds,
      region: "us-east-1",
      modelId: "model",
      payload: "{}",
      cloudflareAccountId: "acct123",
      gatewayId: "gw1",
      gatewayAuthToken: "gwtoken",
      fetchImpl,
    });

    expect(seenHeaders["cf-aig-authorization"]).toBe("Bearer gwtoken");
  });

  it("throws with the response body inlined on a non-2xx", async () => {
    const fetchImpl = stubFetch(
      () => new Response("access denied", { status: 403 }),
    );

    await expect(
      invokeBedrockSigned({
        creds,
        region: "us-east-1",
        modelId: "model",
        payload: "{}",
        cloudflareAccountId: "acct123",
        gatewayId: "gw1",
        fetchImpl,
      }),
    ).rejects.toThrow(
      "Bedrock InvokeModel via AI Gateway failed: HTTP 403 — access denied",
    );
  });
});
