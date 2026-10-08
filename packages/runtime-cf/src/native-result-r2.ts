import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import {
  bindNativeReceipt, bindNativeResult, NativeApiEvidence, NativeReadBinding,
  NativeReceipt, NativeReceiptRefused, NativeRequest, NativeVerifiedResult,
  admitNativeReadBinding, NativeArtifactPath, NativeCapturedFile, NATIVE_RESULT_MAX_BYTES,
  nativeFileChunkKey, type NativeResultFile,
} from "@fractalboxdev/flare-dispatch-core";

const Publication = Schema.Struct({
  request: NativeRequest, receipt: NativeReceipt, api: NativeApiEvidence,
  verifiedArtifacts: NativeReceipt.fields.artifacts,
  files: Schema.Array(NativeCapturedFile),
  verifiedAt: NativeVerifiedResult.fields.verified_at,
});
const refused = (reason: string) => new NativeReceiptRefused({ reason });
const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknown(schema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(() => new NativeReceiptRefused({ reason: "native result identity or encoding invalid" })),
  );

/** Reader deadlines share this immutable namespace without changing its request identity. */
export const nativeResultKey = (binding: NativeReadBinding | NativeRequest): string =>
  `native-results/v1/${binding.repo}/${binding.head}/${binding.base}/${binding.nonce}/${binding.target}/${binding.command_sha256}/${binding.executor_ref}.json`;

/** Only the authenticated controller publishes here; workload artifacts have a separate namespace. */
export const makeNativeResultR2 = (bucket: Pick<R2Bucket, "get" | "put">, controllerLogin: string) => {
  const chunkBytes = async (identity: NativeReadBinding, chunk: NativeResultFile["chunks"][number]) => {
    const object = await bucket.get(nativeFileChunkKey(identity, chunk.sha256));
    if (object === null) throw refused("native file chunk absent");
    if (object.size !== chunk.bytes) {
      await object.body.cancel(); throw refused("native file chunk size mismatch");
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== chunk.bytes || createHash("sha256").update(bytes).digest("hex") !== chunk.sha256)
      throw refused("native file chunk digest mismatch");
    return bytes;
  };
  const storedText = (key: string) => Effect.gen(function* () {
    const object = yield* Effect.tryPromise({
      try: () => bucket.get(key),
      catch: () => new NativeReceiptRefused({ reason: "native result storage read unavailable" }),
    });
    if (object === null) return yield* Effect.fail(new NativeReceiptRefused({ reason: "verified native result absent" }));
    if (object.size > NATIVE_RESULT_MAX_BYTES) {
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
    const binding = yield* admitNativeReadBinding(rawBinding, now);
    const text = yield* storedText(nativeResultKey(binding));
    const result = yield* decode(Schema.parseJson(NativeVerifiedResult), text);
    return yield* bindNativeResult(binding, result, controllerLogin, now);
  });

  /** Each chunk verifies before emission; whole-file verification completes at stream EOF. */
  const readFile = (rawBinding: unknown, rawPath: unknown, now: number) => Effect.gen(function* () {
    const path = yield* decode(NativeArtifactPath, rawPath);
    const binding = yield* admitNativeReadBinding(rawBinding, now);
    const result = yield* read(binding, now);
    const file = result.files.find((file) => file.path === path);
    if (file === undefined) return yield* Effect.fail(refused("native result file absent"));
    const digest = createHash("sha256");
    let index = 0, bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = file.chunks[index];
          if (chunk === undefined) {
            if (bytes !== file.bytes || digest.digest("hex") !== file.sha256)
              throw refused("native file digest or size mismatch");
            controller.close(); return;
          }
          const part = await chunkBytes(binding, chunk);
          digest.update(part); bytes += part.byteLength; index++;
          controller.enqueue(part);
        } catch { controller.error(refused("native file read verification refused")); }
      },
    }, { highWaterMark: 0 });
    return { result, path: file.path, sha256: file.sha256, bytes: file.bytes, body };
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
      files: publication.files.map(({ path, sha256, bytes, chunks }) => ({
        path, sha256, bytes, chunks: chunks.map(({ sha256, bytes }) => ({ sha256, bytes })),
      })),
    }, controllerLogin, now);
    yield* Effect.tryPromise({
      try: async () => {
        for (const file of publication.files) {
          const digest = createHash("sha256");
          for (const chunk of file.chunks) {
            if (chunk.key !== nativeFileChunkKey(binding, chunk.sha256))
              throw refused("native file chunk identity mismatch");
            digest.update(await chunkBytes(binding, chunk));
          }
          if (digest.digest("hex") !== file.sha256) throw refused("native file digest mismatch");
        }
      },
      catch: () => refused("native result byte verification refused"),
    });
    const text = JSON.stringify(result);
    if (new TextEncoder().encode(text).byteLength > NATIVE_RESULT_MAX_BYTES)
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
  return { read, readFile, publish };
};
