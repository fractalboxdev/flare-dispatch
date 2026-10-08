import { Effect, Schema } from "effect";
import {
  bindNativeReceipt, bindNativeResult, NativeApiEvidence, NativeReadBinding,
  NativeReceipt, NativeReceiptRefused, NativeRequest, NativeVerifiedResult,
} from "@fractalboxdev/flare-dispatch-core";

const Publication = Schema.Struct({
  request: NativeRequest, receipt: NativeReceipt, api: NativeApiEvidence,
  verifiedArtifacts: NativeReceipt.fields.artifacts,
  verifiedAt: NativeVerifiedResult.fields.verified_at,
});
const MAX_RESULT_BYTES = 128 * 1024;
const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknown(schema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(() => new NativeReceiptRefused({ reason: "native result identity or encoding invalid" })),
  );

/** Reader deadlines share this immutable namespace without changing its request identity. */
export const nativeResultKey = (binding: NativeReadBinding): string =>
  `native-results/v1/${binding.repo}/${binding.head}/${binding.base}/${binding.nonce}/${binding.target}/${binding.command_sha256}/${binding.executor_ref}.json`;

/** Only the authenticated controller publishes here; workload artifacts have a separate namespace. */
export const makeNativeResultR2 = (bucket: Pick<R2Bucket, "get" | "put">, controllerLogin: string) => {
  const storedText = (key: string) => Effect.gen(function* () {
    const object = yield* Effect.tryPromise({
      try: () => bucket.get(key),
      catch: () => new NativeReceiptRefused({ reason: "native result storage read unavailable" }),
    });
    if (object === null) return yield* Effect.fail(new NativeReceiptRefused({ reason: "verified native result absent" }));
    if (object.size > MAX_RESULT_BYTES) {
      yield* Effect.tryPromise({
        try: () => object.body.cancel(),
        catch: () => new NativeReceiptRefused({ reason: "native result body disposal unavailable" }),
      });
      return yield* Effect.fail(new NativeReceiptRefused({ reason: "native result exceeds storage bound" }));
    }
    return yield* Effect.tryPromise({
      try: () => object.text(),
      catch: () => new NativeReceiptRefused({ reason: "native result body read unavailable" }),
    });
  });

  const read = (rawBinding: unknown, now: number) => Effect.gen(function* () {
    const binding = yield* decode(NativeReadBinding, rawBinding);
    const text = yield* storedText(nativeResultKey(binding));
    const result = yield* decode(Schema.parseJson(NativeVerifiedResult), text);
    return yield* bindNativeResult(binding, result, controllerLogin, now);
  });

  const publish = (raw: unknown, now: number) => Effect.gen(function* () {
    const publication = yield* decode(Publication, raw);
    const receipt = yield* bindNativeReceipt(publication.request, publication.receipt,
      publication.api, publication.verifiedArtifacts, controllerLogin);
    const request = publication.request;
    const binding = yield* decode(NativeReadBinding, {
      version: 1, repo: request.repo, head: request.head, base: request.base, nonce: request.nonce,
      target: request.target, command_sha256: request.command_sha256,
      executor_ref: request.executor_ref, expires_at: now + 1,
    });
    const result = yield* bindNativeResult(binding, {
      version: 1, request, receipt, api: publication.api, verified_at: publication.verifiedAt,
    }, controllerLogin, now);
    const text = JSON.stringify(result);
    if (new TextEncoder().encode(text).byteLength > MAX_RESULT_BYTES)
      return yield* Effect.fail(new NativeReceiptRefused({ reason: "native result exceeds storage bound" }));
    const key = nativeResultKey(binding);
    const object = yield* Effect.tryPromise({
      try: () => bucket.put(key, text, {
        onlyIf: new Headers({ "if-none-match": "*" }),
        httpMetadata: { contentType: "application/json" },
      }),
      catch: () => new NativeReceiptRefused({ reason: "native result persistence outcome uncertain" }),
    });
    if (object === null && (yield* storedText(key)) !== text)
      return yield* Effect.fail(new NativeReceiptRefused({ reason: "native result immutable publication conflicts" }));
    return result;
  });
  return { read, publish };
};
