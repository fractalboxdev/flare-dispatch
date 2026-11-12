// The services an agentic recipe's body calls inside the job sandbox: the model gateway through the egress proxy, the
// checkout's shell, the intents it returns, the artifact store and its staged write (specs/runs/agentic.md § Model).
import { Context, Effect, Layer, Schema } from "effect";
import { assertNoCredentialInRequest, type ModelMessage } from "../boundary.ts";
import type { Tier } from "../declaration.ts";
import type { Manifest, PullRequestFields } from "../staged-write/manifest.ts";

export const MODEL_FAILURE_KINDS = [
  "rate-limited",
  "context-overflow",
  "unavailable",
  "refused",
] as const;

export class ModelCallError extends Schema.TaggedError<ModelCallError>()("ModelCallError", {
  kind: Schema.Literals(MODEL_FAILURE_KINDS),
  detail: Schema.String,
}) {}

export interface ModelRequest {
  readonly callSite: string;
  readonly tier: Tier;
  readonly messages: readonly ModelMessage[];
  readonly maxTokens?: number;
}

/** One model call; the answer is the completion text. */
export class ModelClient extends Context.Service<
  ModelClient,
  { readonly complete: (request: ModelRequest) => Effect.Effect<string, ModelCallError> }
>()("@fractalboxdev/flare-dispatch-agentic/ModelClient") {}

export interface ModelGatewayClientOptions {
  /** The model gateway's URL as the egress proxy serves it to the sandbox. */
  readonly url: string;
  readonly fetch: typeof globalThis.fetch;
  /** Credentials present in the sandbox's environment, such as a clone token, that no request may carry. */
  readonly forbidden: readonly string[];
}

const kindOf = (status: number, text: string): (typeof MODEL_FAILURE_KINDS)[number] =>
  status === 429 || /rate[ _-]?limit/i.test(text)
    ? "rate-limited"
    : /context window|context length|maximum context|prompt is too long|input is too long|too many tokens/i.test(
          text,
        )
      ? "context-overflow"
      : status === 401 || status === 402 || status === 403
        ? "refused"
        : "unavailable";

/**
 * `ModelClient` over the model gateway through the egress proxy. The request carries no credential: the proxy attaches
 * the execution's per-lease token (FD-AGT-010), and a request holding a credential is refused before it leaves
 * (FD-AGT-011).
 */
export const modelGatewayClientLayer = (
  options: ModelGatewayClientOptions,
): Layer.Layer<ModelClient> =>
  Layer.succeed(ModelClient, {
    complete: (request) =>
      Effect.gen(function* () {
        const leak = assertNoCredentialInRequest(request.messages, options.forbidden);
        if (leak !== null)
          return yield* new ModelCallError({
            kind: "refused",
            detail: `credential in message ${leak.message}`,
          });
        const response = yield* Effect.tryPromise({
          try: () =>
            options.fetch(options.url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                call_site: request.callSite,
                tier: request.tier,
                messages: request.messages,
                ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
              }),
            }),
          catch: (cause) => new ModelCallError({ kind: "unavailable", detail: String(cause) }),
        });
        const text = yield* Effect.promise(() => response.text().catch(() => ""));
        if (!response.ok)
          return yield* new ModelCallError({
            kind: kindOf(response.status, text),
            detail: text.slice(0, 300),
          });
        return yield* Effect.try({
          try: () => {
            const body = JSON.parse(text) as { text?: unknown };
            return typeof body.text === "string" ? body.text : "";
          },
          catch: () =>
            new ModelCallError({
              kind: "unavailable",
              detail: "the gateway answered a body that is not JSON",
            }),
        });
      }),
  });

export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A command in the checkout. A command that cannot start answers exit code null. */
export class Shell extends Context.Service<
  Shell,
  {
    readonly run: (
      command: string,
      options?: { readonly timeoutMs?: number; readonly cwd?: string },
    ) => Effect.Effect<CommandResult>;
  }
>()("@fractalboxdev/flare-dispatch-agentic/Shell") {}

/** The intents a run returns, each keyed `run:<step name>:<index>` by the runner. */
export class RecipeIntents extends Context.Service<
  RecipeIntents,
  { readonly append: (step: string, kind: string, payload: unknown) => Effect.Effect<void> }
>()("@fractalboxdev/flare-dispatch-agentic/RecipeIntents") {}

export type ArtifactAccess = "dashboard";

/** The artifact store under the execution; `dashboard` access is readable only through the authenticated route. */
export class Artifacts extends Context.Service<
  Artifacts,
  {
    readonly put: (
      name: string,
      bytes: Uint8Array,
      access: ArtifactAccess,
    ) => Effect.Effect<void, ArtifactFailed>;
  }
>()("@fractalboxdev/flare-dispatch-agentic/Artifacts") {}

export class ArtifactFailed extends Schema.TaggedError<ArtifactFailed>()("ArtifactFailed", {
  detail: Schema.String,
}) {}

export class StageFailed extends Schema.TaggedError<StageFailed>()("StageFailed", {
  detail: Schema.String,
}) {}

/** Stages the checkout's changes as the execution's staged write, which the result reports. */
export class StagedWrites extends Context.Service<
  StagedWrites,
  {
    readonly stage: (input: {
      readonly branch: string;
      readonly baseBranch: string;
      readonly message: string;
      readonly pr: PullRequestFields;
    }) => Effect.Effect<Manifest, StageFailed>;
  }
>()("@fractalboxdev/flare-dispatch-agentic/StagedWrites") {}

/** A file a recipe writes into the checkout before staging. */
export class Checkout extends Context.Service<
  Checkout,
  {
    readonly read: (path: string) => Effect.Effect<string | null>;
    readonly write: (path: string, text: string) => Effect.Effect<void, StageFailed>;
    readonly list: (dir: string) => Effect.Effect<readonly string[]>;
  }
>()("@fractalboxdev/flare-dispatch-agentic/Checkout") {}

/** A model failure as the run's verdict: the capacity reasons of mameko's admission, or an infrastructure failure. */
export const modelFailureVerdict = (
  e: ModelCallError,
): { readonly _tag: "failure"; readonly reason: string } =>
  e.kind === "rate-limited"
    ? { _tag: "failure", reason: "capacity: model unavailable" }
    : e.kind === "context-overflow"
      ? { _tag: "failure", reason: "capacity: context overflow" }
      : { _tag: "failure", reason: `infra: model ${e.kind}` };

/**
 * One edit-loop run. `started` is false when the executable could not start; `exitCode` is null when the process
 * started and a signal ended it, such as the loop's timeout.
 */
export interface EditLoopResult {
  readonly started: boolean;
  readonly exitCode: number | null;
}

/** The edit loop: the coding agent that edits the checkout in the job sandbox under the `agent` egress profile. */
export class EditLoop extends Context.Service<
  EditLoop,
  { readonly run: (prompt: string) => Effect.Effect<EditLoopResult> }
>()("@fractalboxdev/flare-dispatch-agentic/EditLoop") {}

/**
 * Whether the edit loop is unavailable: its executable did not start, or exited 126 (not executable) or 127 (not
 * found). A loop that started and was killed, or exited any other code, leaves the verdict to the recipe's check.
 */
export const editLoopUnavailable = (loop: EditLoopResult) =>
  !loop.started || loop.exitCode === 126 || loop.exitCode === 127;

/** A suppression ledger row: the proposal's key, declined for good, or the matching pull request's close time. */
export interface SuppressionEntry {
  readonly key: string;
  readonly declined: boolean;
  /** When the matching pull request closed unmerged, epoch ms; null when none did. */
  readonly closedAt: number | null;
}

export class SuppressionReadFailed extends Schema.TaggedError<SuppressionReadFailed>()(
  "SuppressionReadFailed",
  { key: Schema.String, detail: Schema.String },
) {}

/**
 * The suppression ledger, read by a proposal's exact suppression key (specs/runs/agentic.md § Suppression ledger). A
 * key with no row answers null; a read that fails is `SuppressionReadFailed`, never null (FD-AGT-042, FD-AGT-044).
 */
export class SuppressionLedger extends Context.Service<
  SuppressionLedger,
  {
    readonly lookup: (key: string) => Effect.Effect<SuppressionEntry | null, SuppressionReadFailed>;
  }
>()("@fractalboxdev/flare-dispatch-agentic/SuppressionLedger") {}

/** The execution a run body serves: its id as the control plane assigned it. */
export class ExecutionIdentity extends Context.Service<
  ExecutionIdentity,
  { readonly executionId: string }
>()("@fractalboxdev/flare-dispatch-agentic/ExecutionIdentity") {}
