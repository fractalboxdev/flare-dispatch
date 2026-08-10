// AWS Bedrock InvokeModel via Cloudflare AI Gateway — container-side caller.
//
// The SigV4 + AI-Gateway signing core lives in `@fractalboxdev/flare-dispatch-bedrock-sigv4`
// (shared with the Worker-side `runtime-cf` twin). This file is the container
// caller: it builds the Anthropic-Messages-with-tool_use body the demo play
// loop needs, hands it to the shared signer, and parses the response into
// content blocks + stop reason. (The Worker side ships only the text-only body
// shape, since review uses generateText, not tools.)
//
// Spec: specs/05-byoc.md § AWS federation; CF docs:
// https://developers.cloudflare.com/ai-gateway/usage/providers/bedrock/

import {
  type AwsCreds,
  invokeBedrockSigned,
} from "@fractalboxdev/flare-dispatch-bedrock-sigv4";

export type { AwsCreds };

/** One tool the model may call (Anthropic Messages tool shape). */
export type AnthropicTool = {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool's input. */
  readonly input_schema: unknown;
};

/** A message block — Anthropic Messages content blocks (text only on input). */
export type AnthropicMessage = {
  readonly role: "user" | "assistant";
  readonly content: string | ReadonlyArray<unknown>;
};

/** Tool choice — auto / required / specific tool. */
export type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string };

export type BedrockInvokeInput = {
  readonly creds: AwsCreds;
  readonly region: string;
  readonly modelId: string;
  /** System prompt (Anthropic top-level field, not a message). */
  readonly system?: string;
  readonly messages: ReadonlyArray<AnthropicMessage>;
  readonly tools?: ReadonlyArray<AnthropicTool>;
  readonly toolChoice?: AnthropicToolChoice;
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** CF account id — first segment of the gateway URL. */
  readonly cloudflareAccountId: string;
  /** AI Gateway slug — second segment of the gateway URL. */
  readonly gatewayId: string;
  /** Optional `cf-aig-authorization` token for an Authenticated Gateway. */
  readonly gatewayAuthToken?: string;
  /** Test override for `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

/** One Anthropic content block in the response. */
export type AnthropicContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    };

export type BedrockInvokeResult = {
  readonly content: ReadonlyArray<AnthropicContentBlock>;
  readonly stopReason: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
};

const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";

/**
 * Build the Anthropic-Messages-with-tool_use body, SigV4-sign + POST it through
 * the AI Gateway (via the shared signer), and parse the response into content
 * blocks + stop reason. Throws on non-2xx (the shared signer inlines the body).
 */
export const invokeBedrockViaAiGateway = async (
  input: BedrockInvokeInput,
): Promise<BedrockInvokeResult> => {
  const body: Record<string, unknown> = {
    anthropic_version: BEDROCK_ANTHROPIC_VERSION,
    messages: input.messages,
    max_tokens: input.maxTokens ?? 4096,
  };
  if (input.system !== undefined) body["system"] = input.system;
  if (input.temperature !== undefined) body["temperature"] = input.temperature;
  if (input.tools !== undefined && input.tools.length > 0) {
    body["tools"] = input.tools;
    if (input.toolChoice !== undefined) body["tool_choice"] = input.toolChoice;
  }

  const res = await invokeBedrockSigned({
    creds: input.creds,
    region: input.region,
    modelId: input.modelId,
    payload: JSON.stringify(body),
    cloudflareAccountId: input.cloudflareAccountId,
    gatewayId: input.gatewayId,
    gatewayAuthToken: input.gatewayAuthToken,
    fetchImpl: input.fetchImpl,
  });

  const json = (await res.json()) as {
    content?: ReadonlyArray<AnthropicContentBlock>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const result: BedrockInvokeResult = {
    content: json.content ?? [],
    stopReason: json.stop_reason ?? "end_turn",
    ...(json.usage?.input_tokens !== undefined
      ? { inputTokens: json.usage.input_tokens }
      : {}),
    ...(json.usage?.output_tokens !== undefined
      ? { outputTokens: json.usage.output_tokens }
      : {}),
  };
  return result;
};
