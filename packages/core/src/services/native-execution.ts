import { Context, Effect, Layer, Schema } from "effect";
import { NativeRequest, NativeReceiptRefused } from "../native-windows";

export const NativeReleaseInput = Schema.Struct({
  head: NativeRequest.fields.head, target: NativeRequest.fields.target,
  profile: Schema.Literal("contextful-edge", "contextful-full"),
});
export type NativeReleaseInput = typeof NativeReleaseInput.Type;

/** Release has no comparison scope: only this mode binds base to its immutable head. */
export const NativeReleaseHandle = Schema.Struct({ request: NativeRequest }).pipe(
  Schema.filter(({ request }) => request.mode === "release" && request.base === request.head && request.profile !== ""),
);
export type NativeReleaseHandle = typeof NativeReleaseHandle.Type;

export const NativeGateInput = Schema.Struct({
  head: NativeRequest.fields.head, base: NativeRequest.fields.base, target: NativeRequest.fields.target,
});
export type NativeGateInput = typeof NativeGateInput.Type;
export const NativeGateHandle = Schema.Struct({ request: NativeRequest }).pipe(
  Schema.filter(({ request }) => request.mode === "gate" && request.profile === ""),
);
export type NativeGateHandle = typeof NativeGateHandle.Type;

export const NativeReleaseObservation = Schema.Union(
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("ready"), files: Schema.Array(Schema.Struct({
    path: Schema.String, sha256: Schema.String, bytes: Schema.Number,
  })) }),
);
export type NativeReleaseObservation = typeof NativeReleaseObservation.Type;

/** Recipes receive no App credential or dispatch authority outside the configured native owner. */
export interface NativeExecutionService {
  readonly admitGate: (input: NativeGateInput) => Effect.Effect<NativeGateHandle, NativeReceiptRefused>;
  readonly observeGate: (handle: NativeGateHandle) => Effect.Effect<NativeReleaseObservation, NativeReceiptRefused>;
  readonly admitRelease: (input: NativeReleaseInput) => Effect.Effect<NativeReleaseHandle, NativeReceiptRefused>;
  readonly observeRelease: (handle: NativeReleaseHandle) => Effect.Effect<NativeReleaseObservation, NativeReceiptRefused>;
  readonly readReleaseFile: (handle: NativeReleaseHandle, path: string) => Effect.Effect<{
    body: ReadableStream<Uint8Array>; size: number; sha256: string;
  }, NativeReceiptRefused>;
}
export class NativeExecution extends Context.Tag("@fractalboxdev/flare-dispatch-core/NativeExecution")<NativeExecution, NativeExecutionService>() {}
const unavailable = () => Effect.fail(new NativeReceiptRefused({ reason: "native execution owner is not configured" }));
export const NativeExecutionUnavailable = Layer.succeed(NativeExecution, {
  admitGate: unavailable, observeGate: unavailable,
  admitRelease: unavailable, observeRelease: unavailable, readReleaseFile: unavailable,
});
export const nativeExecution = {
  admitGate: (input: NativeGateInput) => Effect.flatMap(NativeExecution, owner => owner.admitGate(input)),
  observeGate: (handle: NativeGateHandle) => Effect.flatMap(NativeExecution, owner => owner.observeGate(handle)),
  admitRelease: (input: NativeReleaseInput) => Effect.flatMap(NativeExecution, owner => owner.admitRelease(input)),
  observeRelease: (handle: NativeReleaseHandle) => Effect.flatMap(NativeExecution, owner => owner.observeRelease(handle)),
  readReleaseFile: (handle: NativeReleaseHandle, path: string) => Effect.flatMap(NativeExecution, owner => owner.readReleaseFile(handle, path)),
};
