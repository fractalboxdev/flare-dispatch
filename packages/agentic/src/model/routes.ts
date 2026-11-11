// FlareDispatch's two route kinds in the model gateway's provider registry, `workers-ai` and `bedrock`, and how a
// `workers-ai` model entry is priced (specs/model-gateway.md). Both routes run in the control plane: the Workers AI
// binding is the `workers-ai` credential, and the gateway signs every `bedrock` request.
import {
  DEFAULT_FALLBACK_PRICE_USD_PER_MTOK,
  ModelCallFailed,
  ModelRequestInvalid,
  sendHostedCall,
  type HostedEntry,
  type HostedRoute,
  type RouteAnswer,
} from "@fractalboxdev/mameko-gateway";
import type { ModelCallTier } from "@fractalboxdev/mameko-kernel";
import { Effect } from "effect";
import { signRequest, type AwsCredentials } from "./sigv4.ts";

/** The route kinds FlareDispatch registers, and no other (FD-MDL-020). */
export const FD_ROUTE_KINDS = ["workers-ai", "bedrock"] as const;
export type FdRouteKind = (typeof FD_ROUTE_KINDS)[number];

/** mameko's built-in route kinds (MAMEKO-MDL-021). */
export const MAMEKO_ROUTE_KINDS = [
  "openai-compatible",
  "anthropic-messages",
  "cloudflare-ai-gateway",
  "local",
] as const;

/** The route kinds configuration validation accepts with FlareDispatch's registered (FD-MDL-020). */
export const ACCEPTED_ROUTE_KINDS: readonly string[] = [...FD_ROUTE_KINDS, ...MAMEKO_ROUTE_KINDS];

/** The price of one Workers AI Neuron, 0.011 USD per 1,000, in micro-USD. */
export const MICRO_USD_PER_NEURON = 11;

/** A provider registry entry as the configuration source holds it. */
export interface RegistryEntry {
  readonly id: string;
  readonly providerId: string;
  readonly routeKind: string;
  /** The model-call tiers the entry serves; never empty. */
  readonly serves: readonly ModelCallTier[];
  readonly inputPriceMicroUsdPerMTok?: number;
  readonly outputPriceMicroUsdPerMTok?: number;
  /** A `workers-ai` entry's Neurons per million tokens, from which its per-token rate derives (FD-MDL-022). */
  readonly neuronsPerMTok?: { readonly input: number; readonly output: number };
  readonly upstreamModel: string;
}

export interface RegistryRejection {
  readonly entry: string;
  readonly reason: string;
}

/**
 * The deploy check over the provider registry: every route kind is one of the accepted kinds (FD-MDL-020), and each
 * `workers-ai` entry states a per-token rate equal to its Neurons price (FD-MDL-022).
 */
export const checkRegistry = (entries: readonly RegistryEntry[]): readonly RegistryRejection[] =>
  entries.flatMap((e): RegistryRejection[] => {
    if (!ACCEPTED_ROUTE_KINDS.includes(e.routeKind))
      return [{ entry: e.id, reason: `route kind ${e.routeKind} is not registered` }];
    if (e.routeKind !== "workers-ai") return [];
    const n = e.neuronsPerMTok;
    if (
      n === undefined ||
      e.inputPriceMicroUsdPerMTok === undefined ||
      e.outputPriceMicroUsdPerMTok === undefined
    )
      return [
        {
          entry: e.id,
          reason: "workers-ai entry states no per-token rate derived from its Neurons price",
        },
      ];
    if (
      e.inputPriceMicroUsdPerMTok !== n.input * MICRO_USD_PER_NEURON ||
      e.outputPriceMicroUsdPerMTok !== n.output * MICRO_USD_PER_NEURON
    )
      return [{ entry: e.id, reason: "workers-ai per-token rate differs from its Neurons price" }];
    return [];
  });

export type EntryPrice =
  | { readonly _tag: "priced"; readonly input: number; readonly output: number }
  | { readonly _tag: "unpriced"; readonly entry: string };

/**
 * A hosted entry's price: its stated rate, else the fallback rate (MAMEKO-MDL-022), except a `workers-ai` entry, which
 * is never priced at the fallback rate (FD-MDL-021) and answers `unpriced` without its derived rate.
 */
export const entryPrice = (
  entry: RegistryEntry,
  fallback: { readonly input: number; readonly output: number },
): EntryPrice => {
  if (entry.routeKind === "workers-ai")
    return entry.inputPriceMicroUsdPerMTok === undefined ||
      entry.outputPriceMicroUsdPerMTok === undefined
      ? { _tag: "unpriced", entry: entry.id }
      : {
          _tag: "priced",
          input: entry.inputPriceMicroUsdPerMTok,
          output: entry.outputPriceMicroUsdPerMTok,
        };
  return {
    _tag: "priced",
    input: entry.inputPriceMicroUsdPerMTok ?? fallback.input,
    output: entry.outputPriceMicroUsdPerMTok ?? fallback.output,
  };
};

/**
 * Sends one hosted call through the model gateway with the entry priced by `entryPrice`: a `workers-ai` entry without
 * its derived rate is refused before any reservation or upstream request, and every other entry reaches the gateway
 * with both prices stated, so the gateway never prices a `workers-ai` entry at the fallback rate (FD-MDL-021).
 */
export const sendFdHostedCall = (
  input: Parameters<typeof sendHostedCall>[0],
): ReturnType<typeof sendHostedCall> => {
  const fallback = Math.round(
    (input.fallbackPriceUsdPerMTok ?? DEFAULT_FALLBACK_PRICE_USD_PER_MTOK) * 1_000_000,
  );
  const price = entryPrice(input.entry, { input: fallback, output: fallback });
  return price._tag === "unpriced"
    ? Effect.fail(
        new ModelRequestInvalid({
          reason: `workers-ai entry ${price.entry} states no per-token rate, and the fallback rate never prices it`,
        }),
      )
    : sendHostedCall({
        ...input,
        entry: {
          ...input.entry,
          inputPriceMicroUsdPerMTok: price.input,
          outputPriceMicroUsdPerMTok: price.output,
        },
      });
};

/** The capacity reason a provider error text names, so a recipe can conclude on it. */
export const failureKind = (text: string): "rate-limited" | "context-overflow" | "upstream" =>
  /context window|context length|context limit|maximum context|prompt is too long|input is too long|too many tokens/i.test(
    text,
  )
    ? "context-overflow"
    : /\b429\b|rate[ _-]?limit|too many requests|quota exceeded/i.test(text)
      ? "rate-limited"
      : "upstream";

const fail = (text: string) =>
  new ModelCallFailed({ reason: `${failureKind(text)}: ${text.slice(0, 300)}` });

/** The slice of the Workers AI binding the route calls. */
export interface WorkersAiBinding {
  readonly run: (
    model: string,
    inputs: {
      readonly messages: readonly { readonly role: string; readonly content: string }[];
      readonly max_tokens: number;
    },
  ) => Promise<unknown>;
}

interface WorkersAiOutput {
  readonly response?: unknown;
  readonly choices?: readonly { readonly message?: { readonly content?: unknown } }[];
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
}

/** A Workers AI answer's text: the legacy `response`, else the chat-completion `choices[0].message.content`. */
export const workersAiText = (output: unknown): string => {
  const o = (output ?? {}) as WorkersAiOutput;
  const raw = o.response ?? o.choices?.[0]?.message?.content;
  return typeof raw === "string"
    ? raw
    : raw === undefined || raw === null
      ? ""
      : JSON.stringify(raw);
};

/** The `workers-ai` route: the Workers AI binding of `host-cloudflare`, which is its only credential. */
export const workersAiRoute = (ai: WorkersAiBinding): HostedRoute => ({
  send: (entry: HostedEntry, request) =>
    Effect.tryPromise({
      try: () =>
        ai.run(entry.upstreamModel, { messages: request.messages, max_tokens: request.maxTokens }),
      catch: (cause) => fail(cause instanceof Error ? cause.message : String(cause)),
    }).pipe(
      Effect.map((output): RouteAnswer => {
        const usage = (output as WorkersAiOutput | null)?.usage;
        return {
          body: { text: workersAiText(output) },
          usage:
            typeof usage?.prompt_tokens === "number" && typeof usage.completion_tokens === "number"
              ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }
              : null,
          cacheHit: null,
        };
      }),
    ),
});

export interface BedrockRouteConfig {
  readonly region: string;
  /** The credentials of the role the control plane assumes. */
  readonly credentials: Effect.Effect<AwsCredentials, ModelCallFailed>;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => Date;
}

const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";

/**
 * The `bedrock` route: an Anthropic Messages body to `InvokeModel`, signed with SigV4 in the control plane (FD-MDL-024).
 * The system message travels as `system`, every other message in order.
 */
export const bedrockRoute = (config: BedrockRouteConfig): HostedRoute => ({
  send: (entry, request) =>
    Effect.gen(function* () {
      const credentials = yield* config.credentials;
      const host = `bedrock-runtime.${config.region}.amazonaws.com`;
      const model = encodeURIComponent(entry.upstreamModel);
      const system = request.messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");
      const body = JSON.stringify({
        anthropic_version: BEDROCK_ANTHROPIC_VERSION,
        max_tokens: request.maxTokens,
        ...(system === "" ? {} : { system }),
        messages: request.messages
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role, content: m.content })),
      });
      const headers = yield* Effect.promise(() =>
        signRequest({
          credentials,
          region: config.region,
          service: "bedrock",
          host,
          canonicalPath: `/model/${encodeURIComponent(model)}/invoke`,
          body,
          now: (config.now ?? (() => new Date()))(),
        }),
      );
      const response = yield* Effect.tryPromise({
        try: () =>
          config.fetch(`https://${host}/model/${model}/invoke`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json", accept: "application/json" },
            body,
          }),
        catch: (cause) => fail(String(cause)),
      });
      const text = yield* Effect.promise(() => response.text().catch(() => ""));
      if (!response.ok) return yield* fail(`bedrock ${response.status}: ${text}`);
      const parsed = yield* Effect.try({
        try: () =>
          JSON.parse(text) as {
            content?: readonly { type: string; text?: string }[];
            usage?: { input_tokens?: number; output_tokens?: number };
          },
        catch: () => fail("bedrock answered a body that is not JSON"),
      });
      return {
        body: {
          text: (parsed.content ?? [])
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join(""),
        },
        usage:
          typeof parsed.usage?.input_tokens === "number" &&
          typeof parsed.usage.output_tokens === "number"
            ? { inputTokens: parsed.usage.input_tokens, outputTokens: parsed.usage.output_tokens }
            : null,
        cacheHit: null,
      } satisfies RouteAnswer;
    }),
});

/** The registered routes by kind, for the gateway's dispatch on an entry's route kind. */
export const fdRoutes = (input: {
  readonly ai: WorkersAiBinding;
  readonly bedrock: BedrockRouteConfig;
}): Readonly<Record<FdRouteKind, HostedRoute>> => ({
  "workers-ai": workersAiRoute(input.ai),
  bedrock: bedrockRoute(input.bedrock),
});
