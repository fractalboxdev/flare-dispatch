import { Effect, Schema } from "effect";
import { NativeControllerPolicy, NativeReceiptRefused, NativeRequest, admitNativeRequest } from "@fractalboxdev/flare-dispatch-core";

/** Operator configuration supplies native executor queue/execution duration and polling cadence; neither has an implicit default. */
export const NativeWorkflowPolicy = Schema.Struct({
  repo: NativeRequest.fields.repo,
  executor_ref: NativeRequest.fields.executor_ref,
  timeoutSec: NativeControllerPolicy.fields.timeoutSec,
  pollIntervalSec: Schema.Number.pipe(Schema.filter((n) => Number.isSafeInteger(n) && n > 0)),
});
export type NativeWorkflowPolicy = typeof NativeWorkflowPolicy.Type;
export const NativeWorkflowParams = Schema.Struct({ request: NativeRequest, policy: NativeWorkflowPolicy });
export type NativeWorkflowParams = typeof NativeWorkflowParams.Type;

export const readNativeWorkflowPolicy = (raw: unknown) => Schema.decodeUnknown(Schema.parseJson(NativeWorkflowPolicy),
  { onExcessProperty: "error" })(raw).pipe(
    Effect.mapError(() => new NativeReceiptRefused({ reason: "native Workflow operator policy unavailable" })),
  );

export const admitNativeWorkflowRequest = (raw: unknown, policy: NativeWorkflowPolicy) => Effect.gen(function* () {
  const request = yield* admitNativeRequest(raw);
  if (request.repo !== policy.repo || request.executor_ref !== policy.executor_ref)
    return yield* Effect.fail(new NativeReceiptRefused({ reason: "native Workflow configured scope conflicts" }));
  return request;
});

/** Complete admitted request identity determines one instance across ambiguous create acknowledgements. */
export const nativeWorkflowId = async (raw: unknown) => {
  const request = await Effect.runPromise(admitNativeRequest(raw));
  const fields = Object.keys(NativeRequest.fields).sort() as (keyof NativeRequest)[];
  const identity = fields.map(field => [field, request[field]]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(identity)));
  return `native-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
};
