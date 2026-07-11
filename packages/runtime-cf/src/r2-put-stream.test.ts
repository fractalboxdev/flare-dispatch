// Unit tests for `putStream` — the chunking/branch logic, against a FAKE R2
// bucket. Env-independent (no Miniflare): the Node forks-pool's R2 binding
// doesn't implement `createMultipartUpload`, and the container-file source
// needs no container here — we drive `putStream` with a plain ReadableStream.
// Real R2 multipart behavior is validated by a `wrangler dev` smoke.

import { describe, expect, it } from "vitest";
import { putStream } from "./r2-put-stream";

const MiB = 1024 * 1024;

/** A fake R2 bucket recording single-PUTs and multipart calls. */
const makeFakeBucket = () => {
  const puts: { key: string; bytes: Uint8Array }[] = [];
  const parts: { partNumber: number; bytes: Uint8Array }[] = [];
  const state = { completedParts: -1, aborted: false, mpKey: "" };
  const bucket = {
    put: async (key: string, body: ArrayBuffer | ArrayBufferView) => {
      puts.push({ key, bytes: new Uint8Array(body as ArrayBuffer) });
      return {} as R2Object;
    },
    createMultipartUpload: async (key: string) => {
      state.mpKey = key;
      return {
        uploadPart: async (
          partNumber: number,
          value: ArrayBuffer | ArrayBufferView,
        ) => {
          const bytes = new Uint8Array(
            value instanceof ArrayBuffer
              ? value
              : (value.buffer as ArrayBuffer).slice(
                  value.byteOffset,
                  value.byteOffset + value.byteLength,
                ),
          );
          parts.push({ partNumber, bytes });
          return { partNumber, etag: `etag-${partNumber}` };
        },
        complete: async (uploaded: { partNumber: number }[]) => {
          state.completedParts = uploaded.length;
          return {} as R2Object;
        },
        abort: async () => {
          state.aborted = true;
        },
      };
    },
  } as unknown as R2Bucket;
  return { bucket, puts, parts, state };
};

/** A ReadableStream that yields `chunks` then closes. */
const streamOf = (chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });

const fill = (n: number, byte: number): Uint8Array =>
  new Uint8Array(n).fill(byte);

describe("putStream", () => {
  it("small body (≤16 MiB) → one buffered PUT, no multipart", async () => {
    const { bucket, puts, parts } = makeFakeBucket();
    const body = streamOf([fill(3 * MiB, 7), fill(2 * MiB, 9)]);
    await putStream(bucket, "k", body, 5 * MiB, { contentType: "application/gzip" });
    expect(puts).toHaveLength(1);
    expect(puts[0]!.bytes.byteLength).toBe(5 * MiB);
    expect(puts[0]!.bytes[0]).toBe(7);
    expect(puts[0]!.bytes[3 * MiB]).toBe(9);
    expect(parts).toHaveLength(0);
  });

  it("large body (>16 MiB) → multipart; parts ≥5 MiB except last; full coverage", async () => {
    const { bucket, parts, state } = makeFakeBucket();
    // 20 MiB delivered in 1 MiB chunks, each tagged with its index so we can
    // verify ordering + completeness after reassembly.
    const total = 20 * MiB;
    const chunks = Array.from({ length: 20 }, (_, i) => fill(MiB, i));
    await putStream(bucket, "big", streamOf(chunks), total, {
      contentType: "application/gzip",
    });

    // Reassembled multipart payload equals the input, in order.
    const assembled = new Uint8Array(parts.reduce((n, p) => n + p.bytes.byteLength, 0));
    let off = 0;
    for (const p of parts) {
      assembled.set(p.bytes, off);
      off += p.bytes.byteLength;
    }
    expect(assembled.byteLength).toBe(total);
    for (let i = 0; i < 20; i++) expect(assembled[i * MiB]).toBe(i);

    // Every non-final part is ≥5 MiB (R2's hard rule); parts are 1-indexed and
    // contiguous; `complete` saw them all.
    expect(parts.length).toBeGreaterThan(1);
    parts.slice(0, -1).forEach((p) =>
      expect(p.bytes.byteLength).toBeGreaterThanOrEqual(5 * MiB),
    );
    expect(parts.map((p) => p.partNumber)).toEqual(
      parts.map((_, i) => i + 1),
    );
    expect(state.completedParts).toBe(parts.length);
    expect(state.aborted).toBe(false);
  });

  it("aborts the multipart upload if the stream errors mid-way", async () => {
    const { bucket, state } = makeFakeBucket();
    const failing = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(fill(9 * MiB, 1));
      },
      pull() {
        throw new Error("stream broke");
      },
    });
    await expect(
      putStream(bucket, "k", failing, 30 * MiB, { contentType: "application/gzip" }),
    ).rejects.toThrow();
    expect(state.aborted).toBe(true);
  });
});
