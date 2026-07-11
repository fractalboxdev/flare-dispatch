// @fractalboxdev/flare-dispatch-runtime-cf — decode the Sandbox SDK's SSE-framed file
// stream back into raw bytes.
//
// `box.readFileStream(path)` does not yield the file's bytes: it yields the
// raw body of the SDK's server-sent-events endpoint —
//
//   data: {"type":"metadata","mimeType":"application/gzip","size":N,...}
//   data: {"type":"chunk","data":"<base64>", ...}
//   data: {"type":"chunk","data":"<base64>", ...}
//   ...
//
// Uploading that body verbatim is issue #90: every container-tar artifact and
// cache archive stored the SSE TEXT, so downloads were not valid gzip and the
// browse expansion (#96) failed at the gunzip step. This module turns the
// framed stream back into the file's bytes by decoding the `chunk` frames in
// order.
//
// --- Chunk encoding follows the metadata frame (issue #106) ------------------
//
// The SDK base64-encodes chunks ONLY for binary files; a TEXT file's chunks
// (e.g. `application/json` — product-demo's rrweb `replay-N.json`) carry the
// raw text in `data`. Blindly `atob()`ing every chunk threw
// `InvalidCharacterError` on every text-file upload while binary uploads
// (PNG, gzip) passed — the metadata frame's `isBinary` field is the
// discriminator (mirroring the SDK's own `streamFile` helper). Text chunks
// re-encode as UTF-8; the caller's `stat` size remains the loud-failure
// backstop if the byte count ever drifts.
//
// --- Defensive sniffing -------------------------------------------------------
//
// Whether the SDK frames the body is a transport/SDK-version detail, not a
// contract we control. So the decoder SNIFFS: only a stream whose first bytes
// are exactly `data: {"type":` is treated as SSE-framed; anything else passes
// through untouched. A future SDK that returns raw bytes keeps working, and a
// real file beginning with that 14-byte prefix is not a case the upload path
// has (it ships gzip tarballs, which start with the 0x1f 0x8b magic).
//
// The expected RAW byte size comes from the caller's `stat` (the decoded
// chunks must add up to it — R2 rejects a length mismatch, which is the
// loud-failure backstop if the frame shape ever drifts).

const SSE_PREFIX = new TextEncoder().encode('data: {"type":');

/** Does `bytes` start with the SSE frame prefix? */
const isSseFramed = (bytes: Uint8Array): boolean => {
  if (bytes.length < SSE_PREFIX.length) return false;
  for (let i = 0; i < SSE_PREFIX.length; i++) {
    if (bytes[i] !== SSE_PREFIX[i]) return false;
  }
  return true;
};

const base64ToBytes = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

/** Decode complete `data: {...}` lines, enqueueing each chunk frame's bytes. */
const makeFrameParser = () => {
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();
  let lineBuffer = "";
  // Chunks are base64 ONLY for binary files (the SDK's `streamFile` gate);
  // a text file's chunks carry raw text. Default true: when no metadata
  // frame precedes the first chunk, the historical base64 behaviour applies.
  let binaryChunks = true;
  return {
    push(
      bytes: Uint8Array,
      controller: TransformStreamDefaultController<Uint8Array>,
    ): void {
      lineBuffer += textDecoder.decode(bytes, { stream: true });
      for (;;) {
        const nl = lineBuffer.indexOf("\n");
        if (nl === -1) return;
        const line = lineBuffer.slice(0, nl).trimEnd();
        lineBuffer = lineBuffer.slice(nl + 1);
        if (!line.startsWith("data: ")) continue;
        let frame: { type?: string; data?: string; isBinary?: boolean };
        try {
          frame = JSON.parse(line.slice(6)) as {
            type?: string;
            data?: string;
            isBinary?: boolean;
          };
        } catch {
          continue; // not a JSON frame — ignore (e.g. SSE comments/keepalives)
        }
        if (frame.type === "metadata" && frame.isBinary === false) {
          binaryChunks = false;
        }
        if (frame.type === "chunk" && typeof frame.data === "string") {
          controller.enqueue(
            binaryChunks
              ? base64ToBytes(frame.data)
              : textEncoder.encode(frame.data),
          );
        }
      }
    },
  };
};

/**
 * Wrap a `readFileStream` body: SSE-framed input is decoded back to the
 * file's raw bytes; already-raw input passes through unchanged.
 */
export const decodeSseByteStream = (
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> => {
  let sniffed = false;
  let framed = false;
  let held = new Uint8Array(0);
  let parser: ReturnType<typeof makeFrameParser> | undefined;

  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!sniffed) {
          // Accumulate until the prefix is decidable (tiny first chunks).
          const merged = new Uint8Array(held.length + chunk.length);
          merged.set(held);
          merged.set(chunk, held.length);
          held = merged;
          if (
            held.length < SSE_PREFIX.length &&
            isSseFramed(held.subarray(0, held.length)) === false &&
            // still a possible prefix-in-progress? keep holding
            SSE_PREFIX.subarray(0, held.length).every((b, i) => held[i] === b)
          ) {
            return;
          }
          sniffed = true;
          framed = isSseFramed(held);
          if (framed) parser = makeFrameParser();
          const first = held;
          held = new Uint8Array(0);
          if (framed) {
            parser!.push(first, controller);
          } else {
            controller.enqueue(first);
          }
          return;
        }
        if (framed) {
          parser!.push(chunk, controller);
        } else {
          controller.enqueue(chunk);
        }
      },
      flush(controller) {
        // Stream ended before the sniff resolved — pass the held bytes raw.
        if (!sniffed && held.length > 0) controller.enqueue(held);
      },
    }),
  );
};
