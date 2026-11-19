import { Effect, Schema } from "effect";

export class NativeBodyRefused extends Schema.TaggedError<NativeBodyRefused>()("NativeBodyRefused", {
  status: Schema.Literal(400, 408, 413),
}) {}

/** Native HTTP bodies share one bounded receiver and nonblocking cancellation owner. */
export const readNativeBody = (request: Request) => Effect.gen(function* () {
  if (request.body === null) return yield* Effect.fail(new NativeBodyRefused({ status: 400 }));
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => request.body!.getReader()),
    (reader) => Effect.gen(function* () {
      const bytes = new Uint8Array(4096);
      let size = 0;
      for (;;) {
        const { done, value } = yield* Effect.tryPromise({ try: () => reader.read(), catch: () => new NativeBodyRefused({ status: 400 }) });
        if (done) break;
        if (!(value instanceof Uint8Array) || value.byteLength === 0)
          return yield* Effect.fail(new NativeBodyRefused({ status: 400 }));
        if (size + value.byteLength > bytes.byteLength)
          return yield* Effect.fail(new NativeBodyRefused({ status: 413 }));
        bytes.set(value, size); size += value.byteLength;
      }
      return bytes.subarray(0, size);
    }),
    (reader) => Effect.sync(() => { void reader.cancel().catch(() => {}); reader.releaseLock(); }),
  ).pipe(Effect.timeoutFail({ duration: "10 seconds", onTimeout: () => new NativeBodyRefused({ status: 408 }) }));
});

export const decodeNativeBody = (bytes: Uint8Array) => Effect.try({
  try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
  catch: () => new NativeBodyRefused({ status: 400 }),
});
