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

export const nativeReadMessage = (binding: NativeReadBinding): string => JSON.stringify([
  binding.version, binding.repo, binding.head, binding.base, binding.nonce, binding.target,
  binding.command_sha256, binding.executor_ref, binding.expires_at,
]);

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
  const binding = yield* decode(NativeReadBinding, rawBinding);
  const result = yield* decode(NativeVerifiedResult, rawResult);
  const refuse = (reason: string) => Effect.fail(new NativeReceiptRefused({ reason }));
  if (!Number.isSafeInteger(now) || now <= 0 || now >= binding.expires_at
    || result.verified_at > now || result.verified_at * 1000 < Date.parse(result.receipt.completed_at)) {
    return yield* refuse("native result reader deadline or verification time mismatch");
  }
  for (const key of ["repo", "head", "base", "nonce", "target", "command_sha256", "executor_ref"] as const) {
    if (binding[key] !== result.request[key]) return yield* refuse(`native reader ${key} mismatch`);
  }
  yield* bindNativeReceipt(result.request, result.receipt, result.api, result.receipt.artifacts, trustedControllerLogin);
  return result;
});
