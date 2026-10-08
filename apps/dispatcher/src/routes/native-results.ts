import { Effect, Schema } from "effect";
import { NativeArtifactPath, NativeReadBinding, NativeReceiptRefused } from "@fractalboxdev/flare-dispatch-core";
import { makeNativeResultR2, readNativeResultOwnerD1 } from "@fractalboxdev/flare-dispatch-runtime-cf/native";
import type { Env } from "../env";
import { verifyNativeResultToken } from "../native-result-token";

const Input = Schema.Struct({ binding: NativeReadBinding, path: Schema.optional(NativeArtifactPath) });
const MAX_BODY_BYTES = 4096;
class BodyRefused extends Schema.TaggedError<BodyRefused>()("NativeReaderBodyRefused", {
  status: Schema.Literal(400, 408, 413),
}) {}
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const json = (value: unknown, status: number) => new Response(JSON.stringify(value), {
  status, headers: { ...headers, "content-type": "application/json" },
});

/** A bounded receiver owns cancellation; the web-request JSON helper buffers without a byte limit. */
const readInput = (request: Request) => Effect.gen(function* () {
  if (request.body === null) return yield* Effect.fail(new BodyRefused({ status: 400 }));
  const text = yield* Effect.acquireUseRelease(
    Effect.sync(() => request.body!.getReader()),
    (reader) => Effect.gen(function* () {
      const bytes = new Uint8Array(MAX_BODY_BYTES);
      let size = 0;
      for (;;) {
        const { done, value } = yield* Effect.tryPromise({ try: () => reader.read(), catch: () => new BodyRefused({ status: 400 }) });
        if (done) break;
        if (!(value instanceof Uint8Array) || value.byteLength === 0)
          return yield* Effect.fail(new BodyRefused({ status: 400 }));
        if (size + value.byteLength > MAX_BODY_BYTES)
          return yield* Effect.fail(new BodyRefused({ status: 413 }));
        bytes.set(value, size); size += value.byteLength;
      }
      return yield* Effect.try({ try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, size)),
        catch: () => new BodyRefused({ status: 400 }) });
    }),
    (reader) => Effect.sync(() => { void reader.cancel().catch(() => {}); reader.releaseLock(); }),
  ).pipe(Effect.timeoutFail({ duration: "10 seconds", onTimeout: () => new BodyRefused({ status: 408 }) }));
  return yield* Schema.decodeUnknown(Schema.parseJson(Input), { onExcessProperty: "error" })(text).pipe(
    Effect.mapError(() => new BodyRefused({ status: 400 })),
  );
});

/** The signed header admits the request; persisted controller ownership admits the result namespace. */
export const handleNativeResultRead = (request: Request, env: Env): Promise<Response> => Effect.runPromise(
  Effect.gen(function* () {
    if (new URL(request.url).search !== "") return json({ error: "invalid_native_reader_request" }, 400);
    const ikm = env.HMAC_SECRET ?? "";
    if (ikm === "") return json({ error: "native_reader_not_configured" }, 503);
    const authorization = request.headers.get("authorization");
    if (authorization === null) return json({ error: "native_reader_unauthorized" }, 401);
    const input = yield* readInput(request);
    const now = Math.floor(Date.now() / 1000);
    const valid = yield* Effect.tryPromise({
      try: () => verifyNativeResultToken(ikm, input.binding, authorization, now),
      catch: () => new NativeReceiptRefused({ reason: "native reader verification unavailable" }),
    });
    if (!valid) return json({ error: "native_reader_unauthorized" }, 401);
    const appId = env.GITHUB_APP_ID;
    if (appId === undefined || !/^[1-9][0-9]*$/.test(appId)) return json({ error: "native_reader_not_configured" }, 503);
    const owner = yield* readNativeResultOwnerD1(env.RUNS_METADATA, input.binding, Number(appId), now);
    const repository = makeNativeResultR2(env.RUNS_STORAGE, owner.controllerLogin);
    const matches = (receipt: { readonly run_id: string; readonly run_attempt: string }) =>
      receipt.run_id === String(owner.runId) && receipt.run_attempt === String(owner.runAttempt);
    if (input.path === undefined) {
      const result = yield* repository.read(input.binding, now);
      if (!matches(result.receipt)) return yield* Effect.fail(new NativeReceiptRefused({ reason: "native result durable run mismatch" }));
      return json(result, 200);
    }
    const file = yield* repository.readFile(input.binding, input.path, now);
    if (!matches(file.result.receipt)) {
      yield* Effect.promise(() => file.body.cancel());
      return yield* Effect.fail(new NativeReceiptRefused({ reason: "native result durable run mismatch" }));
    }
    return new Response(file.body, { status: 200, headers: { ...headers,
      "content-type": "application/octet-stream", "content-length": String(file.bytes), "x-native-sha256": file.sha256 } });
  }).pipe(
    Effect.catchTag("NativeReaderBodyRefused", ({ status }) => Effect.succeed(json({ error: "invalid_native_reader_request" }, status))),
    Effect.catchTag("NativeReceiptRefused", () => Effect.succeed(json({ error: "native_result_unavailable" }, 503))),
  ),
);
