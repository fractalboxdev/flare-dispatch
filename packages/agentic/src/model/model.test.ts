import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ModelCallFailed } from "@fractalboxdev/mameko-gateway";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  bedrockRoute,
  checkRegistry,
  entryPrice,
  FD_ROUTE_KINDS,
  failureKind,
  workersAiRoute,
  type RegistryEntry,
} from "./routes.ts";

const entry = {
  id: "m1",
  providerId: "p",
  routeKind: "workers-ai",
  tier: "bulk",
  inputPriceMicroUsdPerMTok: 0,
  outputPriceMicroUsdPerMTok: 0,
  providerPath: "",
  upstreamModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
} as const;

const request = {
  messages: [
    { role: "system", content: "You classify." },
    { role: "user", content: "Classify this." },
  ],
  maxTokens: 512,
};

describe("provider registry", () => {
  const workersAi: RegistryEntry = {
    id: "wa",
    providerId: "cf",
    routeKind: "workers-ai",
    tier: "bulk",
    neuronsPerMTok: { input: 26_668, output: 204_805 },
    inputPriceMicroUsdPerMTok: 26_668 * 11,
    outputPriceMicroUsdPerMTok: 204_805 * 11,
    upstreamModel: "@cf/x",
  };

  it("FD-MDL-020 registers workers-ai and bedrock only; validation accepts those and mameko's built-in kinds", () => {
    expect(FD_ROUTE_KINDS).toEqual(["workers-ai", "bedrock"]);
    const of = (routeKind: string): RegistryEntry => ({
      ...workersAi,
      id: routeKind,
      routeKind,
      neuronsPerMTok: undefined,
    });
    expect(
      checkRegistry([
        workersAi,
        ...[
          "bedrock",
          "openai-compatible",
          "anthropic-messages",
          "cloudflare-ai-gateway",
          "local",
        ].map(of),
      ]),
    ).toEqual([]);
    expect(checkRegistry([of("vertex")])).toEqual([
      { entry: "vertex", reason: "route kind vertex is not registered" },
    ]);
  });

  it("FD-MDL-022 the deploy check fails a workers-ai entry with no per-token rate derived from its Neurons price", () => {
    const { neuronsPerMTok: _n, ...noNeurons } = workersAi;
    const { inputPriceMicroUsdPerMTok: _i, ...noRate } = workersAi;
    expect(checkRegistry([noNeurons])[0]?.reason).toMatch(/no per-token rate/);
    expect(checkRegistry([noRate])[0]?.reason).toMatch(/no per-token rate/);
    expect(checkRegistry([{ ...workersAi, inputPriceMicroUsdPerMTok: 1 }])[0]?.reason).toMatch(
      /differs/,
    );
  });

  it("FD-MDL-021 never prices a workers-ai entry at the fallback rate", () => {
    const fallback = { input: 75_000_000, output: 75_000_000 };
    expect(entryPrice(workersAi, fallback)).toEqual({
      _tag: "priced",
      input: 26_668 * 11,
      output: 204_805 * 11,
    });
    const {
      inputPriceMicroUsdPerMTok: _i,
      outputPriceMicroUsdPerMTok: _o,
      ...unpriced
    } = workersAi;
    expect(entryPrice(unpriced, fallback)).toEqual({ _tag: "unpriced", entry: "wa" });
    expect(entryPrice({ ...unpriced, routeKind: "bedrock" }, fallback)).toEqual({
      _tag: "priced",
      ...fallback,
    });
  });
});

describe("workers-ai route", () => {
  it("calls the binding with the entry's model and reports the provider's usage", async () => {
    const calls: unknown[] = [];
    const route = workersAiRoute({
      run: async (model, inputs) => {
        calls.push({ model, inputs });
        return { response: "bug", usage: { prompt_tokens: 12, completion_tokens: 3 } };
      },
    });
    const answer = await Effect.runPromise(route.send(entry, request));
    expect(answer).toEqual({
      body: { text: "bug" },
      usage: { inputTokens: 12, outputTokens: 3 },
      cacheHit: null,
    });
    expect(calls).toEqual([
      { model: entry.upstreamModel, inputs: { messages: request.messages, max_tokens: 512 } },
    ]);
  });

  it("names the capacity reason of a failed call", async () => {
    const route = workersAiRoute({
      run: async () => {
        throw new Error("5021: exceeded this model context window limit");
      },
    });
    const error = await Effect.runPromise(Effect.flip(route.send(entry, request)));
    expect(error).toBeInstanceOf(ModelCallFailed);
    expect(error.reason.startsWith("context-overflow")).toBe(true);
    expect(failureKind("HTTP 429 Too Many Requests")).toBe("rate-limited");
    expect(failureKind("failed to generate response")).toBe("upstream");
  });
});

const referenceSignature = (secret: string, date: string, region: string, stringToSign: string) => {
  const h = (key: Buffer | string, m: string) => createHmac("sha256", key).update(m).digest();
  const k = h(h(h(h(`AWS4${secret}`, date), region), "bedrock"), "aws4_request");
  return createHmac("sha256", k).update(stringToSign).digest("hex");
};

describe("bedrock route", () => {
  it("FD-MDL-024 signs InvokeModel with SigV4 in the control plane and sends the Anthropic body", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const credentials = {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      sessionToken: "session",
    };
    const route = bedrockRoute({
      region: "us-east-1",
      credentials: Effect.succeed(credentials),
      now: () => new Date("2026-01-02T03:04:05.000Z"),
      fetch: (async (url: string, init: RequestInit) => {
        sent.push({ url, init });
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 5, output_tokens: 1 },
          }),
        );
      }) as unknown as typeof fetch,
    });
    const answer = await Effect.runPromise(
      route.send({ ...entry, routeKind: "bedrock", upstreamModel: "anthropic.claude:1" }, request),
    );
    expect(answer).toEqual({
      body: { text: "ok" },
      usage: { inputTokens: 5, outputTokens: 1 },
      cacheHit: null,
    });

    const { url, init } = sent[0] as { url: string; init: RequestInit };
    expect(url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude%3A1/invoke",
    );
    const body = init.body as string;
    expect(JSON.parse(body)).toEqual({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      system: "You classify.",
      messages: [{ role: "user", content: "Classify this." }],
    });
    const headers = init.headers as Record<string, string>;
    const payloadHash = createHash("sha256").update(body).digest("hex");
    const canonical = [
      "POST",
      "/model/anthropic.claude%253A1/invoke",
      "",
      "host:bedrock-runtime.us-east-1.amazonaws.com",
      `x-amz-content-sha256:${payloadHash}`,
      "x-amz-date:20260102T030405Z",
      "x-amz-security-token:session",
      "",
      "host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
      payloadHash,
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      "20260102T030405Z",
      "20260102/us-east-1/bedrock/aws4_request",
      createHash("sha256").update(canonical).digest("hex"),
    ].join("\n");
    expect(headers["authorization"]).toBe(
      `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260102/us-east-1/bedrock/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=${referenceSignature("secret", "20260102", "us-east-1", stringToSign)}`,
    );
  });

  it("FD-MDL-024 the executor entry carries no bedrock route or signer", () => {
    const executorEntry = readFileSync(
      fileURLToPath(new URL("../executor.ts", import.meta.url)),
      "utf8",
    );
    expect(executorEntry).not.toMatch(/routes|sigv4|bedrock/i);
  });
});
