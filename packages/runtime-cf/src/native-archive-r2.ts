import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { crc32 } from "node:zlib";
import { Effect, Schema } from "effect";
import { RandomAccessReader, fromRandomAccessReaderPromise, type Entry } from "yauzl";
import {
  admitNativeRequest, NativeApiEvidence, NativeArtifactPath, NativeControllerLogin,
  NativeReceipt, NativeReceiptRefused, NativeRequest,
} from "@fractalboxdev/flare-dispatch-core";
import { makeNativeFilesR2 } from "./native-files-r2";

const Input = Schema.Struct({ request: NativeRequest, api: NativeApiEvidence, controllerLogin: NativeControllerLogin });
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 257;
const MAX_RECEIPT_BYTES = 128 * 1024;
const refused = () => new NativeReceiptRefused({ reason: "native ZIP archive unavailable, malformed or exceeds extraction bounds" });

/** Every ZIP metadata and data read shares the admitted R2 object version. */
class R2Reader extends RandomAccessReader {
  constructor(private bucket: Pick<R2Bucket, "get">, private key: string, private size: number, private etag: string) { super(); }
  override _readStreamForRange(start: number, end: number): Readable {
    const { bucket, key, size, etag } = this;
    return Readable.from((async function* () {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > size) throw refused();
      const object = await bucket.get(key, { range: { offset: start, length: end - start }, onlyIf: { etagMatches: etag } });
      if (object === null || !("body" in object) || object.etag !== etag) throw refused();
      const reader = object.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          for (let offset = 0; offset < value.byteLength; offset += 65536)
            yield Buffer.from(value.subarray(offset, offset + 65536));
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    })(), { objectMode: false, highWaterMark: 65536 });
  }
}

/** Node stream conversion retains pull backpressure and checks ZIP CRC as bytes pass. */
const entryBody = (stream: Readable, expectedCrc: number) => {
  const iterator = stream[Symbol.asyncIterator](); let checksum = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          if (checksum !== expectedCrc) throw refused();
          controller.close(); return;
        }
        if (!Buffer.isBuffer(next.value) || next.value.byteLength > 256 * 1024) throw refused();
        checksum = crc32(next.value, checksum); controller.enqueue(next.value);
      } catch (error) { stream.destroy(); controller.error(error); }
    },
    async cancel() { stream.destroy(); await iterator.return?.(); },
  }, { highWaterMark: 1 });
};

/** The archive stays in private controller staging; extracted bytes become immutable chunks. */
export const makeNativeArchiveR2 = (bucket: Pick<R2Bucket, "head" | "get" | "put">) => {
  const verify = (raw: unknown, key: string) => Effect.gen(function* () {
    const input = yield* Schema.decodeUnknown(Input, { onExcessProperty: "error" })(raw).pipe(Effect.mapError(refused));
    yield* admitNativeRequest(input.request);
    if (!key.startsWith("native-archive-pending/v1/")) return yield* Effect.fail(refused());
    const object = yield* Effect.tryPromise({ try: () => bucket.head(key), catch: refused });
    if (object === null || !Number.isSafeInteger(object.size) || object.size < 22 || object.size > MAX_ARCHIVE_BYTES)
      return yield* Effect.fail(refused());
    const zip = yield* Effect.tryPromise({
      try: () => fromRandomAccessReaderPromise(new R2Reader(bucket, key, object.size, object.etag), object.size,
        { autoClose: false, lazyEntries: true, strictFileNames: true, validateEntrySizes: true }), catch: refused,
    });
    return yield* Effect.acquireUseRelease(Effect.succeed(zip), () => Effect.gen(function* () {
      const members = yield* Effect.tryPromise({
        try: async () => {
          if (zip.entryCount > MAX_ENTRIES) throw refused();
          const members: Entry[] = [], names = new Set<string>(); let expanded = 0;
          for await (const entry of zip.eachEntry()) {
            const directory = entry.fileName.endsWith("/");
            const path = directory ? entry.fileName.slice(0, -1) : entry.fileName;
            const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
            if (!Schema.is(NativeArtifactPath)(path) || names.has(path.toLowerCase())
              || entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)
              || (directory ? (kind !== 0 && kind !== 0x4000) || entry.uncompressedSize !== 0 : kind !== 0 && kind !== 0x8000)
              || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) throw refused();
            names.add(path.toLowerCase()); expanded += entry.uncompressedSize;
            if (expanded > MAX_ARCHIVE_BYTES) throw refused();
            if (!directory) members.push(entry);
          }
          return members;
        }, catch: refused,
      });
      const receiptEntry = members.find((entry) => entry.fileName === "receipt.json");
      if (receiptEntry === undefined || receiptEntry.uncompressedSize > MAX_RECEIPT_BYTES)
        return yield* Effect.fail(refused());
      const receiptText = yield* Effect.tryPromise({
        try: async () => {
          const body = entryBody(await zip.openReadStreamPromise(receiptEntry), receiptEntry.crc32);
          const bytes = await new Response(body).arrayBuffer();
          if (bytes.byteLength > MAX_RECEIPT_BYTES) throw refused();
          return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
        }, catch: refused,
      });
      const receipt = yield* Schema.decodeUnknown(Schema.parseJson(NativeReceipt), { onExcessProperty: "error" })(receiptText).pipe(Effect.mapError(refused));
      const entries = async function* () {
        for (const entry of members) {
          if (entry === receiptEntry) continue;
          yield { path: entry.fileName, body: entryBody(await zip.openReadStreamPromise(entry), entry.crc32) };
        }
      };
      return yield* makeNativeFilesR2(bucket).verify({ ...input, receipt }, entries());
    }), () => Effect.sync(() => zip.close()));
  });
  return { verify };
};
