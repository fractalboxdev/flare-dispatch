// @fractalboxdev/flare-dispatch-runtime-cf — stream a known-length body into R2 without ever
// materialising it whole in the Worker isolate.
//
// Container artifacts (a Playwright video.webm + trace.zip bundle) and caches
// (a node_modules / pnpm-store tarball) can be tens-to-hundreds of MB. The
// danger was `arrayBuffer()`-ing the WHOLE archive before PUT — a hundreds-of-
// MB blob blows the Worker's 128 MB isolate memory (and stalled the demo run's
// Workflow engine on replay). So:
//   - small (≤ threshold): buffer + single PUT, as before. ≤16 MiB is trivially
//     within budget and a single PUT is the simplest correct path.
//   - large (> threshold): multipart-upload in bounded parts, so peak memory ≈
//     one part, independent of total size.
// We deliberately avoid `FixedLengthStream` (a Workers-only global absent under
// the Node test pool, and a background-pipe deadlock risk) — multipart's
// `uploadPart(Uint8Array)` needs no content-length plumbing.
//
// Both producers (`artifact-r2.ts`, `cache-r2.ts`) get the byte length for free
// from the same RPC that yields the stream: `readFile(path,{encoding:'none'})`
// returns `{ content, size }` for a container file, and `R2ObjectBody` carries
// `.size` for an R2-source copy.
//
// Container-backed callers can't run in `vitest-pool-workers` (no container
// runtime); the R2→R2 path is covered by `artifact-r2.test.ts` (single-PUT) and
// a >threshold multipart case. The container path needs a `wrangler dev` smoke.

const MULTIPART_THRESHOLD = 16 * 1024 * 1024; // 16 MiB
const MULTIPART_PART_SIZE = 8 * 1024 * 1024; //  ≥5 MiB except the final part

/**
 * Stream `body` (yielding exactly `size` bytes) to `bucket` at `key`. `size`
 * must match what `body` produces — R2 rejects a length mismatch.
 */
export const putStream = async (
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array>,
  size: number,
  httpMetadata: R2HTTPMetadata,
): Promise<void> => {
  await putBoundedStream(bucket, key, body, size, httpMetadata, size);
};

/** Unknown-length downloads share the same bounded writer and report their actual byte count. */
export const putBoundedStream = async (
  bucket: R2Bucket, key: string, body: ReadableStream<Uint8Array>, maxBytes: number,
  httpMetadata: R2HTTPMetadata, expectedBytes?: number,
): Promise<number> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || (expectedBytes !== undefined
    && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maxBytes)))
    throw new Error("R2 stream byte bound is invalid");
  const reader = body.getReader();
  let upload: R2MultipartUpload | undefined;
  try {
    const single = (expectedBytes ?? maxBytes) <= MULTIPART_THRESHOLD;
    const buffer = new Uint8Array(single ? expectedBytes ?? maxBytes : MULTIPART_PART_SIZE);
    if (!single) upload = await bucket.createMultipartUpload(key, { httpMetadata });
    const parts: R2UploadedPart[] = [];
    let buffered = 0, bytes = 0;
    let partNumber = 1;
    const flush = async (): Promise<void> => {
      if (buffered === 0 || upload === undefined) return;
      parts.push(await upload.uploadPart(partNumber++, buffer.subarray(0, buffered)));
      buffered = 0;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || bytes + value.byteLength > (expectedBytes ?? maxBytes))
        throw new Error("R2 stream exceeds its byte bound");
      bytes += value.byteLength;
      for (let offset = 0; offset < value.byteLength;) {
        const count = Math.min(buffer.length - buffered, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + count), buffered);
        buffered += count; offset += count;
        if (!single && buffered === buffer.length) await flush();
      }
    }
    if (expectedBytes !== undefined && bytes !== expectedBytes)
      throw new Error("R2 stream is shorter than its declared byte count");
    if (single) await bucket.put(key, buffer.subarray(0, buffered), { httpMetadata });
    else if (bytes === 0) {
      await upload!.abort(); upload = undefined;
      await bucket.put(key, new Uint8Array(), { httpMetadata });
    } else {
      await flush(); await upload!.complete(parts);
    }
    return bytes;
  } catch (cause) {
    await upload?.abort().catch(() => {});
    throw cause;
  } finally {
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
};
