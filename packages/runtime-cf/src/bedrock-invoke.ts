// Bedrock InvokeModel — SigV4-signed POST routed through Cloudflare AI Gateway.
//
// The SigV4 + AI-Gateway signing core lives in `@fractalbox/flare-dispatch-bedrock-sigv4`
// (shared with the demo-agent container twin). This file is the Worker-side
// caller: it builds the text-only Anthropic-on-Bedrock body, hands it to the
// shared signer, and parses the response into `{response, usage}`. `pr-review`'s
// `bedrock` backend uses it via `modelGateway`.
//
// Spec: specs/05-byoc.md § AWS federation; CF docs:
// https://developers.cloudflare.com/ai-gateway/usage/providers/bedrock/

import {
  type AwsCreds,
  invokeBedrockSigned,
} from "@fractalbox/flare-dispatch-bedrock-sigv4";

export type { AwsCreds };

/** Inputs to one Bedrock InvokeModel call. */
export type BedrockInvokeInput = {
  readonly creds: AwsCreds;
  readonly region: string;
  readonly modelId: string;
  /** Anthropic-on-Bedrock body (`{anthropic_version, system, messages, ...}`). */
  readonly body: unknown;
  /** Cloudflare account id — first segment of the gateway URL. */
  readonly cloudflareAccountId: string;
  /** AI Gateway slug — second segment of the gateway URL. */
  readonly gatewayId: string;
  /**
   * Optional `cf-aig-authorization` token (only when the operator's gateway
   * has [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)
   * turned on). Orthogonal to the AWS SigV4 signature.
   */
  readonly gatewayAuthToken?: string;
  /** Optional fetch override for tests. */
  readonly fetchImpl?: typeof fetch;
};

/** What InvokeModel returns — the response text + token usage when present. */
export type BedrockInvokeResult = {
  /** Concatenated text from the response's `content[].text` blocks. */
  readonly response: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
};

/**
 * SigV4-sign + POST a Bedrock InvokeModel request through the AI Gateway, then
 * parse the text-only Anthropic-on-Bedrock response. Throws on non-2xx (the
 * shared signer inlines the response body).
 */
export const invokeBedrockViaAiGateway = async (
  input: BedrockInvokeInput,
): Promise<BedrockInvokeResult> => {
  const res = await invokeBedrockSigned({
    creds: input.creds,
    region: input.region,
    modelId: input.modelId,
    payload: JSON.stringify(input.body),
    cloudflareAccountId: input.cloudflareAccountId,
    gatewayId: input.gatewayId,
    gatewayAuthToken: input.gatewayAuthToken,
    fetchImpl: input.fetchImpl,
  });

  // Anthropic-on-Bedrock body shape:
  //   { content: [{type:"text", text:"..."}],
  //     usage: { input_tokens, output_tokens }, ... }
  const json = (await res.json()) as {
    content?: ReadonlyArray<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const response = (json.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");

  const result: BedrockInvokeResult = {
    response,
    ...(json.usage?.input_tokens !== undefined
      ? { inputTokens: json.usage.input_tokens }
      : {}),
    ...(json.usage?.output_tokens !== undefined
      ? { outputTokens: json.usage.output_tokens }
      : {}),
  };
  return result;
};
