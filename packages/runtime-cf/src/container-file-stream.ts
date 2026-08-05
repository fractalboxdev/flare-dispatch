// @fractalboxdev/flare-dispatch-runtime-cf — read a container file as a stream + byte size.
//
// The artifact/cache upload path needs `{ content, size }` for
// `putStream`'s known-length R2 requirement. `readFile(path, { encoding:
// 'none' })` looked like the one-RPC answer — but it is **rpc-transport
// only** (the SDK throws on HTTP/WebSocket transports), and switching to it
// in #70 broke every container-tar upload on the deployed dispatcher: the
// step failed with the cause swallowed, and the Workflows engine soft-
// restarted on "Worker exceeded CPU time limit" between retries
// (flare-dispatch#88). `readFileStream` — the pre-#70 path that demo-bundle
// uploads shipped on for weeks — works on every transport; the byte length
// comes from one tiny `stat` exec instead.
//
// The container calls can't run under `vitest-pool-workers` (no container
// runtime — same constraint as `sandbox-cf.ts`); `parseStatSize` is the pure
// part, unit-tested in `container-file-stream.test.ts`.

import type { Sandbox } from "@cloudflare/sandbox";
import { decodeSseByteStream } from "./sse-byte-stream";

/**
 * Parse `stat -c %s` output into a byte count. Throws on anything that isn't
 * a plain non-negative integer — a garbled size would make R2 reject the
 * stream (length mismatch) with a far less actionable error.
 */
export const parseStatSize = (stdout: string): number => {
  const trimmed = stdout.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`stat returned unparseable size "${trimmed}"`);
  }
  return Number(trimmed);
};

/**
 * Stream a file out of a sandbox container with its byte length:
 * `stat -c %s` for the size, `readFileStream` for the bytes.
 */
export const readContainerFile = async (
  box: Sandbox,
  path: string,
): Promise<{ content: ReadableStream<Uint8Array>; size: number }> => {
  const stat = await box.exec(`stat -c %s ${path}`);
  if (stat.exitCode !== 0) {
    throw new Error(`stat -c %s ${path} exited ${stat.exitCode}: ${stat.stderr.trim()}`);
  }
  const size = parseStatSize(stat.stdout);
  // The SDK streams the SSE endpoint body, not the file bytes (#90) — decode
  // the chunk frames back to raw bytes (pass-through when already raw).
  const content = decodeSseByteStream(await box.readFileStream(path));
  return { content, size };
};
