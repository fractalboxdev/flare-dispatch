// The GitHub Actions dispatch action (FD-IFC-055 to FD-IFC-061). It checks the signals it collects before anything is
// sent, takes its bearer token from the Actions OIDC token endpoint with the overlay's audience and holds no shared
// secret, dispatches with the shared retry and no `Idempotency-Key`, fails the step at once on any 4xx, and with
// `wait` polls until the verdict, failing the step unless it is `success`.
import {
  Signal,
  SIGNALS_MAX_ENTRIES,
  SignalsV1,
  type SignalsV1 as Signals,
} from "@fractalboxdev/flare-dispatch-api/declaration";
import { Effect, Schema, SchemaIssue } from "effect";
import { makeClient } from "../client.ts";
import { awaitDone, DEFAULT_WAIT_TIMEOUT_S, dispatchWithRetry } from "../dispatching.ts";
import type { FdFailure } from "../outcome.ts";

export interface ActionInputs {
  /** The control plane's origin. */
  readonly url: string;
  /** The overlay's `dispatch.oidcAudience` (FD-IFC-055). */
  readonly audience: string;
  readonly run: string;
  /** `<owner>/<repo>`; the token's `repository` claim must name the same one (FD-IFC-026). */
  readonly repository: string;
  readonly sha: string | undefined;
  /** JSON text of the run's inputs. */
  readonly inputs: string;
  readonly class: string | undefined;
  /** JSON text of a `signals/v1` array, or empty. */
  readonly signals: string;
  readonly wait: boolean;
  readonly waitTimeoutS: number;
}

/** The Actions runtime's OIDC token request URL and its request token, which only a job with `id-token: write` has. */
export interface OidcRequest {
  readonly url: string | undefined;
  readonly token: string | undefined;
}

export class ActionFailed extends Schema.TaggedError<ActionFailed>()("ActionFailed", {
  /** The error code: the route's, or the action's own. */
  code: Schema.String,
  message: Schema.String,
  /** The outputs written before the step failed: a waited dispatch still names its execution. */
  outputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
}) {}

export interface ActionResult {
  readonly outputs: Readonly<Record<string, string>>;
}

const formatter = SchemaIssue.makeFormatterStandardSchemaV1();

/** The step's failure naming the first field of `prefix` that fails its schema. */
const signalsFailure =
  (prefix: string, fallback: string) =>
  (error: Schema.SchemaError): ActionFailed => {
    const first = formatter(error.issue).issues[0];
    const path = (first?.path ?? [])
      .map((p) =>
        typeof p === "object" && p !== null && "key" in p
          ? String((p as { key: PropertyKey }).key)
          : String(p),
      )
      .join(".");
    return new ActionFailed({
      code: "invalid_signals",
      message: `${prefix}${path === "" ? "" : `.${path}`}: ${first?.message ?? fallback}`,
    });
  };

/** The signals, or the step's failure naming the first field over its cap (FD-IFC-061). */
export const checkSignals = (raw: string): Effect.Effect<Signals | undefined, ActionFailed> => {
  if (raw.trim() === "") return Effect.succeed(undefined);
  return Schema.decodeUnknownEffect(Schema.fromJsonString(SignalsV1))(raw).pipe(
    Effect.mapError(signalsFailure("signals", "not a signals/v1 array")),
  );
};

/** An `inputs.signals` entry: the `signals/v1` field caps, with `detail` optional as the dispatcher reads it. */
const InputSignal = Schema.Struct({
  ...Signal.fields,
  detail: Schema.optionalKey(Signal.fields.detail),
});

/**
 * The run inputs' own `signals` merged with the `signals` input, within the caps the dispatcher applies to the same
 * merge (FD-INT-049): at most `SIGNALS_MAX_ENTRIES` entries, each field within its `signals/v1` cap.
 */
export const checkMergedSignals = (
  runInputs: unknown,
  signals: Signals | undefined,
): Effect.Effect<void, ActionFailed> =>
  Effect.gen(function* () {
    const collected =
      runInputs !== null &&
      typeof runInputs === "object" &&
      Array.isArray((runInputs as { signals?: unknown }).signals)
        ? ((runInputs as { signals: unknown[] }).signals as readonly unknown[])
        : [];
    yield* Schema.decodeUnknownEffect(Schema.Array(InputSignal))(collected).pipe(
      Effect.mapError(signalsFailure("inputs.signals", "not a signals/v1 array")),
    );
    const total = collected.length + (signals?.length ?? 0);
    if (total > SIGNALS_MAX_ENTRIES)
      return yield* new ActionFailed({
        code: "invalid_signals",
        message: `inputs.signals and signals: ${total} signals; at most ${SIGNALS_MAX_ENTRIES}`,
      });
  });

/** The job's OIDC token for the audience, from the Actions token endpoint (FD-IFC-055). */
export const oidcToken = (
  request: OidcRequest,
  audience: string,
  fetch: typeof globalThis.fetch,
): Effect.Effect<string, ActionFailed> =>
  Effect.gen(function* () {
    if (request.url === undefined || request.token === undefined)
      return yield* new ActionFailed({
        code: "oidc_unavailable",
        message: "no Actions OIDC token endpoint: the job needs `permissions: id-token: write`",
      });
    const url = new URL(request.url);
    url.searchParams.set("audience", audience);
    const response = yield* Effect.tryPromise({
      try: () => fetch(url, { headers: { authorization: `bearer ${request.token}` } }),
      catch: (e) => new ActionFailed({ code: "oidc_unavailable", message: String(e) }),
    });
    const body = yield* Effect.tryPromise({
      try: () => response.json() as Promise<{ readonly value?: unknown }>,
      catch: () =>
        new ActionFailed({
          code: "oidc_unavailable",
          message: "the token endpoint answered no JSON",
        }),
    });
    if (!response.ok || typeof body.value !== "string")
      return yield* new ActionFailed({
        code: "oidc_unavailable",
        message: `the token endpoint answered ${response.status}`,
      });
    return body.value;
  });

const failed = (failure: FdFailure) =>
  new ActionFailed({ code: failure.code, message: failure.message });

const parseInputs = (raw: string) =>
  Effect.try({
    try: () => JSON.parse(raw.trim() === "" ? "{}" : raw) as unknown,
    catch: () =>
      new ActionFailed({ code: "invalid_inputs", message: "the inputs input is not JSON" }),
  });

export const runAction = (
  inputs: ActionInputs,
  oidc: OidcRequest,
  fetch: typeof globalThis.fetch,
  log: (line: string) => Effect.Effect<void> = () => Effect.void,
): Effect.Effect<ActionResult, ActionFailed> =>
  Effect.gen(function* () {
    const runInputs = yield* parseInputs(inputs.inputs);
    const signals = yield* checkSignals(inputs.signals);
    yield* checkMergedSignals(runInputs, signals);
    const token = yield* oidcToken(oidc, inputs.audience, fetch);
    const client = yield* makeClient(inputs.url, { _tag: "Bearer", token }, fetch);
    const dispatched = yield* dispatchWithRetry(
      client,
      inputs.run,
      {
        repository: inputs.repository,
        inputs: runInputs,
        ...(inputs.sha === undefined ? {} : { sha: inputs.sha }),
        ...(inputs.class === undefined ? {} : { class: inputs.class }),
        ...(signals === undefined ? {} : { signals }),
      },
      (failure, next) => log(`${failure.code}: ${failure.message}; attempt ${next} of 3`),
    ).pipe(Effect.mapError(failed));
    const outputs: Record<string, string> = {
      "execution-id": dispatched.execution_id,
      "details-url": dispatched.details_url,
      "logs-url": dispatched.logs_url,
    };
    if (!inputs.wait) return { outputs };
    const view = yield* awaitDone(client, dispatched.execution_id, inputs.waitTimeoutS).pipe(
      Effect.mapError(failed),
    );
    outputs["verdict"] = view.verdict ?? "none";
    if (view.verdict !== "success")
      return yield* new ActionFailed({
        code: view.verdict ?? "no_verdict",
        message: `execution ${view.execution_id} ended ${view.verdict ?? "without a verdict"}${view.reason === null ? "" : `: ${view.reason}`}`,
        outputs,
      });
    return { outputs };
  });

/** An input as the runner passes it: `INPUT_<NAME>`, upper-cased, with spaces as underscores. */
const input = (env: NodeJS.ProcessEnv, name: string): string =>
  (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();

const optional = (value: string) => (value === "" ? undefined : value);

export const inputsFrom = (env: NodeJS.ProcessEnv): ActionInputs => {
  const timeout = input(env, "wait-timeout");
  return {
    url: input(env, "url").replace(/\/+$/, ""),
    audience: input(env, "audience"),
    run: input(env, "run"),
    repository: optional(input(env, "repository")) ?? env["GITHUB_REPOSITORY"] ?? "",
    sha: optional(input(env, "sha")) ?? env["GITHUB_SHA"],
    inputs: input(env, "inputs"),
    class: optional(input(env, "class")),
    signals: input(env, "signals"),
    wait: input(env, "wait") === "true",
    waitTimeoutS: timeout === "" ? DEFAULT_WAIT_TIMEOUT_S : Number(timeout),
  };
};
