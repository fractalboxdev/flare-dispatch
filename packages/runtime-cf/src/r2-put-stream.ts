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
  if (size <= MULTIPART_THRESHOLD) {
    // Small enough to hold in the isolate; buffer the stream and PUT once.
    const buffered = await new Response(body).arrayBuffer();
    await bucket.put(key, buffered, { httpMetadata });
    return;
  }
  const upload = await bucket.createMultipartUpload(key, { httpMetadata });
  try {
    const reader = body.getReader();
    const parts: R2UploadedPart[] = [];
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let partNumber = 1;
    const flush = async (): Promise<void> => {
      const part = new Uint8Array(pendingBytes);
      let offset = 0;
      for (const chunk of pending) {
        part.set(chunk, offset);
        offset += chunk.byteLength;
      }
      parts.push(await upload.uploadPart(partNumber++, part));
      pending = [];
      pendingBytes = 0;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending.push(value);
      pendingBytes += value.byteLength;
      if (pendingBytes >= MULTIPART_PART_SIZE) await flush();
    }
    if (pendingBytes > 0) await flush();
    await upload.complete(parts);
  } catch (cause) {
    // Don't leave an orphaned multipart upload (R2 also auto-aborts after 7d).
    await upload.abort().catch(() => {});
    throw cause;
  }
};
