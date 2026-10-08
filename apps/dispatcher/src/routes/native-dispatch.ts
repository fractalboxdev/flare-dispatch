import { Effect, Schema } from "effect";
import { NativeReceiptRefused, admitNativeRequest } from "@fractalboxdev/flare-dispatch-core";
import { parseNativeControllerAppId } from "@fractalboxdev/flare-dispatch-github-app";
import type { Env } from "../env";
import { SIGNATURE_HEADER, verify } from "../hmac";
import { NativeBodyRefused, decodeNativeBody, readNativeBody } from "../native-body";
import { nativeWorkflowId, readNativeWorkflowPolicy } from "../native-workflow-policy";

class CreateUncertain extends Schema.TaggedError<CreateUncertain>()("NativeWorkflowCreateUncertain", {}) {}
const Status = Schema.Struct({ status: Schema.Literal("queued", "running", "waiting", "waitingForPause", "paused", "complete", "errored", "terminated") });
const json = (value: unknown, status: number) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" },
});

/** Authenticated requests create only the native Workflow; D1 owns subsequent dispatch admission. */
export const handleNativeDispatch = (request: Request, env: Env) => Effect.runPromise(Effect.gen(function* () {
  if (new URL(request.url).search !== "") return json({ error: "invalid_native_dispatch" }, 400);
  if (env.NATIVE_WORKFLOW === undefined || env.NATIVE_EXECUTION_POLICY === undefined
    || !env.HMAC_SECRET || !env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY)
    return json({ error: "native_dispatch_not_configured" }, 503);
  const policy = yield* readNativeWorkflowPolicy(env.NATIVE_EXECUTION_POLICY);
  const configuredAppId = env.GITHUB_APP_ID;
  yield* Effect.try({ try: () => parseNativeControllerAppId(configuredAppId),
    catch: () => new NativeReceiptRefused({ reason: "native Workflow operator identity unavailable" }) });
  const bytes = yield* readNativeBody(request);
  const valid = yield* Effect.tryPromise({ try: () => verify(env.HMAC_SECRET, request.headers.get(SIGNATURE_HEADER), bytes),
    catch: () => new NativeBodyRefused({ status: 400 }) });
  if (!valid) return json({ error: "native_dispatch_unauthorized" }, 401);
  const text = yield* decodeNativeBody(bytes);
  const raw = yield* Schema.decodeUnknown(Schema.parseJson(Schema.Unknown))(text).pipe(
    Effect.mapError(() => new NativeBodyRefused({ status: 400 })),
  );
  const admitted = yield* admitNativeRequest(raw).pipe(Effect.mapError(() => new NativeBodyRefused({ status: 400 })));
  if (admitted.repo !== policy.repo || admitted.executor_ref !== policy.executor_ref)
    return json({ error: "native_dispatch_scope_refused" }, 403);
  const id = yield* Effect.promise(() => nativeWorkflowId(admitted));
  const binding = env.NATIVE_WORKFLOW;
  return yield* Effect.tryPromise({ try: () => binding.create({ id, params: { request: admitted, policy } }),
    catch: () => new CreateUncertain() }).pipe(
    Effect.map((instance) => instance.id === id ? json({ id, status: "accepted" }, 202)
      : json({ error: "native_dispatch_identity_refused" }, 503)),
    Effect.catchTag("NativeWorkflowCreateUncertain", () => Effect.gen(function* () {
      const instance = yield* Effect.tryPromise({ try: () => binding.get(id), catch: () => new CreateUncertain() });
      if (instance.id !== id) return json({ error: "native_dispatch_identity_refused" }, 503);
      const status = yield* Effect.tryPromise({ try: () => instance.status(), catch: () => new CreateUncertain() });
      const admittedStatus = yield* Schema.decodeUnknown(Status)(status).pipe(Effect.mapError(() => new CreateUncertain()));
      return json({ id, status: admittedStatus.status }, admittedStatus.status === "errored" || admittedStatus.status === "terminated" ? 409 : 202);
    })),
  );
}).pipe(
  Effect.catchTag("NativeBodyRefused", ({ status }) => Effect.succeed(json({ error: "invalid_native_dispatch" }, status))),
  Effect.catchTag("NativeReceiptRefused", () => Effect.succeed(json({ error: "native_dispatch_not_configured" }, 503))),
  Effect.catchTag("NativeWorkflowCreateUncertain", () => Effect.succeed(json({ error: "native_dispatch_outcome_uncertain" }, 503))),
));
