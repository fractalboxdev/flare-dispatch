import { Effect } from "effect";
import { NativeReceiptRefused } from "@fractalboxdev/flare-dispatch-core";
import { NATIVE_ARCHIVE_MAX_BYTES } from "./native-archive-r2";
import { putBoundedStream } from "./r2-put-stream";

const refused = () => new NativeReceiptRefused({ reason: "native archive download or staging refused" });

/** Each authenticated API download receives private controller-owned temporary storage. */
export const makeNativeArchiveDownload = (bucket: R2Bucket, maxBytes = NATIVE_ARCHIVE_MAX_BYTES) => {
  const stage = (response: Response) => Effect.tryPromise({
    try: async () => {
      const text = response.headers.get("content-length");
      const expected = text === null ? undefined : Number(text);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 22 || maxBytes > NATIVE_ARCHIVE_MAX_BYTES
        || response.status !== 200 || response.body === null
        || (text !== null && (!/^(?:0|[1-9][0-9]*)$/.test(text)
          || !Number.isSafeInteger(expected) || expected! < 22 || expected! > maxBytes))) {
        await response.body?.cancel().catch(() => {}); throw refused();
      }
      const key = `native-archive-pending/v1/${crypto.randomUUID()}.zip`;
      try {
        const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            if (!(chunk instanceof Uint8Array) || chunk.byteLength > 256 * 1024) throw refused();
            controller.enqueue(chunk);
          },
        }));
        const bytes = await putBoundedStream(bucket, key, body, maxBytes,
          { contentType: "application/zip" }, expected);
        if (bytes < 22) throw refused();
        return { key, bytes };
      } catch (error) {
        // Only this attempt's unexposed temporary key belongs to this cleanup.
        await bucket.delete(key).catch(() => {}); throw error;
      }
    }, catch: refused,
  });
  return { stage };
};
