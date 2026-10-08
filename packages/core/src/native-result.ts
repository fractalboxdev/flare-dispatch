import { Effect, Schema } from "effect";
import { bindNativeReceipt, NativeApiEvidence, NativeReceipt, NativeRequest, NativeReceiptRefused } from "./native-windows";

/** The capability covers the complete immutable request identity and its absolute reader deadline. */
export const NativeReadBinding = Schema.Struct({
  version: Schema.Literal(1),
  repo: NativeRequest.fields.repo, head: NativeRequest.fields.head, base: NativeRequest.fields.base,
  nonce: NativeRequest.fields.nonce, target: NativeRequest.fields.target,
  command_sha256: NativeRequest.fields.command_sha256, executor_ref: NativeRequest.fields.executor_ref,
  expires_at: Schema.Number.pipe(Schema.filter((value) => Number.isSafeInteger(value) && value > 0)),
});
export type NativeReadBinding = typeof NativeReadBinding.Type;

export const NATIVE_FILE_CHUNK_BYTES = 8 * 1024 * 1024;
export const NATIVE_FILES_MAX_COUNT = 128;
export const NATIVE_FILES_MAX_BYTES = 8 * 1024 * 1024 * 1024;
export const NATIVE_RESULT_MAX_BYTES = 1024 * 1024;

export const NativeFileChunk = Schema.Struct({
  sha256: NativeReceipt.fields.artifacts.value.fields.sha256,
  bytes: Schema.Number.pipe(Schema.filter((value) => Number.isSafeInteger(value) && value > 0 && value <= NATIVE_FILE_CHUNK_BYTES)),
});
export const NativeResultFile = Schema.Struct({
  ...NativeReceipt.fields.artifacts.value.fields,
  chunks: Schema.Array(NativeFileChunk),
});
export type NativeResultFile = typeof NativeResultFile.Type;
export const NativeCapturedFile = Schema.Struct({
  ...NativeReceipt.fields.artifacts.value.fields,
  chunks: Schema.Array(Schema.Struct({ ...NativeFileChunk.fields, key: Schema.String })),
});
export type NativeCapturedFile = typeof NativeCapturedFile.Type;

/** Chunk addresses derive from the complete admitted request and the chunk digest. */
export const nativeFileChunkKey = (identity: NativeRequest | NativeReadBinding, digest: string): string =>
  `native-file-chunks/v1/${identity.repo}/${identity.head}/${identity.base}/${identity.nonce}/${identity.target}/${identity.command_sha256}/${identity.executor_ref}/${digest}`;

export const admitNativeReadBinding = (raw: unknown, now: number) => Effect.gen(function* () {
  const binding = yield* Schema.decodeUnknown(NativeReadBinding, { onExcessProperty: "error" })(raw).pipe(
    Effect.mapError(() => new NativeReceiptRefused({ reason: "invalid native reader identity" })),
  );
  if (!Number.isSafeInteger(now) || now <= 0 || now >= binding.expires_at)
    return yield* Effect.fail(new NativeReceiptRefused({ reason: "native result reader deadline mismatch" }));
  return binding;
});

export const nativeReadMessage = (binding: NativeReadBinding): string => JSON.stringify([
  binding.version, binding.repo, binding.head, binding.base, binding.nonce, binding.target,
  binding.command_sha256, binding.executor_ref, binding.expires_at,
]);

/** The reader capability and persisted request share one complete identity comparison. */
export const bindNativeReadRequest = (binding: NativeReadBinding, request: NativeRequest) => Effect.gen(function* () {
  for (const key of ["repo", "head", "base", "nonce", "target", "command_sha256", "executor_ref"] as const) {
    if (binding[key] !== request[key])
      return yield* Effect.fail(new NativeReceiptRefused({ reason:`native reader ${key} mismatch` }));
  }
  return request;
});

/** The token travels only in Authorization and the runtime's declared, scrubbed secret environment. */
export const NativeReadCapability = Schema.Struct({
  binding: NativeReadBinding,
  authorization: Schema.Redacted(Schema.String.pipe(Schema.nonEmptyString())),
});
export type NativeReadCapability = typeof NativeReadCapability.Type;

/** Only the controller's API-bound publisher writes this immutable result namespace. */
export const NativeVerifiedResult = Schema.Struct({
  version: Schema.Literal(1),
  request: NativeRequest,
  receipt: NativeReceipt,
  api: NativeApiEvidence,
  files: Schema.Array(NativeResultFile),
  verified_at: Schema.Number.pipe(Schema.filter((value) => Number.isSafeInteger(value) && value > 0)),
});
export type NativeVerifiedResult = typeof NativeVerifiedResult.Type;

/** This boundary reads only the controller-owned immutable result namespace. */
export const bindNativeResult = (
  rawBinding: unknown, rawResult: unknown, trustedControllerLogin: string, now: number,
) => Effect.gen(function* () {
  const decode = <A, I>(schema: Schema.Schema<A, I>, raw: unknown) =>
    Schema.decodeUnknown(schema, { onExcessProperty: "error" })(raw).pipe(
      Effect.mapError(() => new NativeReceiptRefused({ reason: "invalid verified native result" })),
    );
  const binding = yield* admitNativeReadBinding(rawBinding, now);
  const result = yield* decode(NativeVerifiedResult, rawResult);
  const refuse = (reason: string) => Effect.fail(new NativeReceiptRefused({ reason }));
  if (!Number.isSafeInteger(now) || now <= 0 || now >= binding.expires_at
    || result.verified_at > now || result.verified_at * 1000 < Date.parse(result.receipt.completed_at)) {
    return yield* refuse("native result reader deadline or verification time mismatch");
  }
  yield* bindNativeReadRequest(binding, result.request);
  if (result.files.length > NATIVE_FILES_MAX_COUNT
    || result.files.reduce((sum, file) => sum + file.bytes, 0) > NATIVE_FILES_MAX_BYTES)
    return yield* refuse("native result exceeds file or byte bound");
  for (const file of result.files) {
    if (file.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) !== file.bytes
      || file.chunks.some((chunk, index) => index < file.chunks.length - 1 && chunk.bytes !== NATIVE_FILE_CHUNK_BYTES))
      return yield* refuse("native file chunk inventory mismatch");
  }
  yield* bindNativeReceipt(result.request, result.receipt, result.api,
    result.files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })), trustedControllerLogin);
  return result;
});
