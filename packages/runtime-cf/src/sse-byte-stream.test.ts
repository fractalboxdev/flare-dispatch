// Unit tests for sse-byte-stream — the #90 fix. Pure stream transforms, no
// container runtime needed.

import { describe, expect, it } from "vitest";
import { decodeSseByteStream } from "./sse-byte-stream";

const encoder = new TextEncoder();

const streamOf = (chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });

const drain = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
  new Uint8Array(await new Response(stream).arrayBuffer());

const b64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));

/** Frame `payload` the way the SDK's readFileStream SSE body does. */
const sseFrames = (payload: Uint8Array, chunkSize: number): string => {
  const lines = [
    `data: {"type":"metadata","mimeType":"application/gzip","size":${payload.length},"isBinary":true}`,
  ];
  for (let i = 0; i < payload.length; i += chunkSize) {
    lines.push(
      `data: {"type":"chunk","data":"${b64(payload.subarray(i, i + chunkSize))}"}`,
    );
  }
  lines.push(`data: {"type":"end"}`);
  return `${lines.join("\n\n")}\n`;
};

describe("decodeSseByteStream", () => {
  // The gzip magic makes the payload realistic AND non-UTF8.
  const payload = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 250, 251, 252]);

  it("decodes a framed stream back to the raw bytes", async () => {
    const framed = encoder.encode(sseFrames(payload, 4));
    const out = await drain(decodeSseByteStream(streamOf([framed])));
    expect(out).toEqual(payload);
  });

  it("decodes frames split across arbitrary chunk boundaries", async () => {
    const framed = encoder.encode(sseFrames(payload, 3));
    // Feed in 5-byte slivers — frame lines straddle every boundary.
    const slivers: Uint8Array[] = [];
    for (let i = 0; i < framed.length; i += 5) {
      slivers.push(framed.subarray(i, i + 5));
    }
    const out = await drain(decodeSseByteStream(streamOf(slivers)));
    expect(out).toEqual(payload);
  });

  it("passes a raw (unframed) stream through byte-identical", async () => {
    const out = await drain(decodeSseByteStream(streamOf([payload])));
    expect(out).toEqual(payload);
  });

  it("passes through a short raw stream that never resolves the sniff", async () => {
    const tiny = new Uint8Array([0x1f, 0x8b]); // shorter than the sniff prefix
    const out = await drain(decodeSseByteStream(streamOf([tiny])));
    expect(out).toEqual(tiny);
  });

  it("passes through raw text that merely starts with 'data'", async () => {
    const text = encoder.encode("database dump v1\n0,1,2\n");
    const out = await drain(decodeSseByteStream(streamOf([text])));
    expect(out).toEqual(text);
  });

  it("decodes TEXT-file frames — raw (non-base64) chunk data after isBinary:false metadata", async () => {
    // The SDK base64-encodes chunks only for binary files; a text file's
    // chunks carry the raw text (#106 — every product-demo replay-N.json
    // upload died on atob() of JSON content).
    const json = `{"sessionId":"abc","events":[{"type":2,"data":{"a":1}}]}`;
    const framed = encoder.encode(
      `data: {"type":"metadata","mimeType":"application/json","size":${json.length},"isBinary":false,"encoding":"utf-8"}\n` +
        `data: {"type":"chunk","data":${JSON.stringify(json.slice(0, 20))}}\n` +
        `data: {"type":"chunk","data":${JSON.stringify(json.slice(20))}}\n` +
        `data: {"type":"complete"}\n`,
    );
    const out = await drain(decodeSseByteStream(streamOf([framed])));
    expect(new TextDecoder().decode(out)).toBe(json);
  });

  it("decodes text frames split across arbitrary transport boundaries", async () => {
    const json = `{"k":"v with spaces and unicode ✓","n":[1,2,3]}`;
    const framed = encoder.encode(
      `data: {"type":"metadata","mimeType":"text/plain","size":0,"isBinary":false}\n` +
        `data: {"type":"chunk","data":${JSON.stringify(json)}}\n`,
    );
    const slivers: Uint8Array[] = [];
    for (let i = 0; i < framed.length; i += 7) {
      slivers.push(framed.subarray(i, i + 7));
    }
    const out = await drain(decodeSseByteStream(streamOf(slivers)));
    expect(new TextDecoder().decode(out)).toBe(json);
  });

  it("ignores non-JSON SSE lines (comments/keepalives)", async () => {
    const framed = encoder.encode(
      `data: {"type":"metadata","size":${payload.length}}\n` +
        `: keepalive\n` +
        `data: not-json\n` +
        `data: {"type":"chunk","data":"${b64(payload)}"}\n` +
        `data: {"type":"end"}\n`,
    );
    const out = await drain(decodeSseByteStream(streamOf([framed])));
    expect(out).toEqual(payload);
  });
});
