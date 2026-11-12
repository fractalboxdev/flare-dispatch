import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import {
  bindNativeReceipt, NativeApiEvidence, NativeControllerLogin, NativeReceipt,
  NativeReceiptRefused, NativeRequest,
  NativeCapturedFile, NATIVE_FILE_CHUNK_BYTES, NATIVE_FILES_MAX_COUNT, NATIVE_FILES_MAX_BYTES, nativeFileChunkKey,
} from "@fractalboxdev/flare-dispatch-core";

const Input = Schema.Struct({ request: NativeRequest, receipt: NativeReceipt,
  api: NativeApiEvidence, controllerLogin: NativeControllerLogin });
const MAX_INPUT_CHUNK = 256 * 1024;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const refuse = (reason: string) => new NativeReceiptRefused({ reason });

/** Controller-only storage; verified results publish after every extracted file passes. */
export const makeNativeFilesR2 = (bucket: Pick<R2Bucket, "get" | "put">) => {
  const verify = (raw: unknown, entries: AsyncIterable<{ path: string; body: ReadableStream<Uint8Array> }>) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknown(Input, { onExcessProperty: "error" })(raw).pipe(
        Effect.mapError(() => refuse("invalid native archive identity")),
      );
      // This preflight admits identity only; actual byte inventory remains unverified.
      yield* bindNativeReceipt(input.request, input.receipt, input.api, input.receipt.artifacts, input.controllerLogin);
      if (input.receipt.artifacts.length > NATIVE_FILES_MAX_COUNT
        || input.receipt.artifacts.reduce((sum, file) => sum + file.bytes, 0) > NATIVE_FILES_MAX_BYTES)
        return yield* Effect.fail(refuse("native archive exceeds file or byte bound"));
      const files = yield* Effect.tryPromise({
        try: async () => {
          const files: NativeCapturedFile[] = [], names = new Set<string>();
          const request = input.request;
          for await (const entry of entries) {
            const expected = input.receipt.artifacts.find((file) => file.path === entry.path);
            const duplicate = names.has(entry.path.toLowerCase());
            if (expected === undefined || duplicate) {
              await entry.body.cancel();
              throw refuse("unexpected or ambiguous native archive file");
            }
            names.add(entry.path.toLowerCase());
            const reader = entry.body.getReader(), digest = createHash("sha256");
            const chunks: NativeCapturedFile["chunks"][number][] = [];
            let buffer = new Uint8Array(Math.min(NATIVE_FILE_CHUNK_BYTES, expected.bytes)), buffered = 0, bytes = 0;
            const flush = async () => {
              if (buffered === 0) return;
              const part = buffer.subarray(0, buffered), sha256 = hash(part);
              const key = nativeFileChunkKey(request, sha256);
              const stored = await bucket.put(key, part, { onlyIf: new Headers({ "if-none-match": "*" }),
                httpMetadata: { contentType: "application/octet-stream" } });
              if (stored === null) {
                const existing = await bucket.get(key);
                if (existing === null) throw refuse("immutable native chunk absent");
                if (existing.size !== buffered) {
                  await existing.body.cancel(); throw refuse("immutable native chunk conflicts");
                }
                if (hash(new Uint8Array(await existing.arrayBuffer())) !== sha256)
                  throw refuse("immutable native chunk conflicts");
              }
              chunks.push({ key, sha256, bytes: buffered });
              buffered = 0;
            };
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value.byteLength > MAX_INPUT_CHUNK || bytes + value.byteLength > expected.bytes)
                  throw refuse("native file stream exceeds admitted size or chunk bound");
                digest.update(value); bytes += value.byteLength;
                for (let offset = 0; offset < value.byteLength;) {
                  const count = Math.min(buffer.length - buffered, value.byteLength - offset);
                  buffer.set(value.subarray(offset, offset + count), buffered);
                  buffered += count; offset += count;
                  if (buffered === buffer.length) await flush();
                }
              }
              if (bytes !== expected.bytes || digest.digest("hex") !== expected.sha256)
                throw refuse("native file digest or size mismatch");
              await flush();
            } finally {
              await reader.cancel().catch(() => {}); reader.releaseLock();
            }
            files.push({ path: entry.path, sha256: expected.sha256, bytes, chunks });
          }
          return files;
        },
        catch: () => refuse("native archive byte verification or persistence refused"),
      });
      const verifiedArtifacts = files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }));
      const receipt = yield* bindNativeReceipt(input.request, input.receipt, input.api,
        verifiedArtifacts, input.controllerLogin);
      return { receipt, verifiedArtifacts, files };
    });
  return { verify };
};
