// The dogfood command's client of the control plane's HTTP routes.
import type { CheckInput } from "@fractalboxdev/flare-dispatch-catalog";
import { Effect, Schema } from "effect";

export class ControlPlaneError extends Schema.TaggedError<ControlPlaneError>()(
  "ControlPlaneError",
  { route: Schema.String, detail: Schema.String },
) {}

export const Health = Schema.Struct({
  status: Schema.String,
  deployment: Schema.String,
  plane_id: Schema.String,
});

const Dispatched = Schema.Struct({ execution_id: Schema.String, class: Schema.String });

export const ExecutionView = Schema.Struct({
  execution_id: Schema.String,
  run: Schema.String,
  class: Schema.String,
  status: Schema.Literals(["queued", "running", "done"]),
  verdict: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  epoch: Schema.NullOr(Schema.Number),
  accepted_epoch: Schema.NullOr(Schema.Number),
  executor_id: Schema.NullOr(Schema.String),
  outcome_intents: Schema.Number,
});
export type ExecutionView = typeof ExecutionView.Type;

/** What the key helper's `identity` answers, as `mameko-cli identity` prints it. */
export const DeviceIdentity = Schema.Struct({
  public_key: Schema.String,
  key_store: Schema.Literals(["secure-enclave", "tpm", "software"]),
  certificate_chain: Schema.Array(Schema.String),
  evidence: Schema.Unknown,
});
export type DeviceIdentity = typeof DeviceIdentity.Type;

export interface ControlPlaneClient {
  readonly register: (input: {
    readonly executorId: string;
    readonly identity: DeviceIdentity;
  }) => Effect.Effect<void, ControlPlaneError>;
  readonly dispatchCheck: (input: {
    readonly repository: string;
    readonly inputs: CheckInput;
  }) => Effect.Effect<typeof Dispatched.Type, ControlPlaneError>;
  readonly execution: (
    id: string,
    waitSec: number,
  ) => Effect.Effect<ExecutionView, ControlPlaneError>;
}

const call = <S extends Schema.Decoder<unknown>>(
  schema: S,
  url: string,
  init: RequestInit,
): Effect.Effect<S["Type"], ControlPlaneError> =>
  Effect.gen(function* () {
    const failed = (detail: string) => new ControlPlaneError({ route: url, detail });
    const response = yield* Effect.tryPromise({
      try: () => fetch(url, init),
      catch: (e) => failed(String(e)),
    });
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (e) => failed(String(e)),
    });
    if (!response.ok) return yield* failed(`${response.status}: ${text}`);
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError((e) => failed(e.message)),
    );
  });

/** Each attempt takes its own timeout signal, so a retry never reuses an expired one. */
export const health = (origin: string) =>
  Effect.suspend(() => call(Health, `${origin}/health`, { signal: AbortSignal.timeout(2_000) }));

export const makeClient = (origin: string, operatorToken: string): ControlPlaneClient => {
  const post = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    register: ({ executorId, identity }) =>
      call(
        Schema.Struct({ executor_id: Schema.String }),
        `${origin}/v1/executors/register`,
        post({
          executor_id: executorId,
          identity,
          labels: [],
          protocol_version: "1",
          code_hash: null,
        }),
      ).pipe(Effect.asVoid),
    dispatchCheck: (body) => call(Dispatched, `${origin}/v1/dispatch/check`, post(body)),
    execution: (id, waitSec) =>
      call(ExecutionView, `${origin}/v1/executions/${id}?wait=${waitSec}`, {
        headers: { authorization: `Bearer ${operatorToken}` },
      }),
  };
};
