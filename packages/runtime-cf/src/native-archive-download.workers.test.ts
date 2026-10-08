import { env } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeNativeArchiveDownload } from "./native-archive-download";

const MiB = 1024 * 1024;
const bytes = (size: number) => new ReadableStream<Uint8Array>({
  start(c) { for (let n = 0; n < size; n += 65536) c.enqueue(new Uint8Array(Math.min(65536, size - n)).fill(71)); c.close(); },
});

describe("native archive download staging in actual R2", () => {
  it("spools unknown HTTP length through actual multipart storage without buffering the archive", async () => {
    const size = 20 * MiB + 17, store = makeNativeArchiveDownload(env.RUNS_STORAGE);
    const staged = await Effect.runPromise(store.stage(new Response(bytes(size))));
    expect(staged.bytes).toBe(size); expect(staged.key).toMatch(/^native-archive-pending\/v1\/[0-9a-f-]+\.zip$/);
    const object = await env.RUNS_STORAGE.get(staged.key);
    expect(object!.size).toBe(size);
    const body = object!.body.getReader(); let count = 0;
    for (;;) { const next = await body.read(); if (next.done) break; count += next.value.byteLength; expect(next.value.every((byte: number) => byte === 71)).toBe(true); }
    body.releaseLock(); expect(count).toBe(size);
  });
  it("admits declared HTTP length only when every body byte matches it", async () => {
    const store = makeNativeArchiveDownload(env.RUNS_STORAGE);
    const accepted = await Effect.runPromise(store.stage(new Response(bytes(123), { headers: { "content-length": "123" } })));
    expect((await env.RUNS_STORAGE.head(accepted.key))!.size).toBe(123);
    for (const length of ["122", "124", "-1", "22.5", "9007199254740993"])
      await expect(Effect.runPromise(store.stage(new Response(bytes(123), { headers: { "content-length": length } })))).rejects.toThrow();
    expect((await env.RUNS_STORAGE.list()).objects.map((object) => object.key)).toEqual([accepted.key]);
  });
  it("aborts and removes owned staging after an unknown-length limit or producer failure", async () => {
    const store = makeNativeArchiveDownload(env.RUNS_STORAGE, 9 * MiB);
    await expect(Effect.runPromise(store.stage(new Response(bytes(10 * MiB))))).rejects.toThrow();
    let produced = 0;
    const failing = new ReadableStream<Uint8Array>({ pull(c) {
      if (produced++ < 128) c.enqueue(new Uint8Array(65536)); else throw new Error("fixture download disconnected");
    } });
    await expect(Effect.runPromise(store.stage(new Response(failing)))).rejects.toThrow();
    expect((await env.RUNS_STORAGE.list()).objects).toHaveLength(0);
  });
  it("isolates downloads and refuses non-success, absent or undersized archives", async () => {
    const store = makeNativeArchiveDownload(env.RUNS_STORAGE);
    for (const response of [new Response(null), new Response(bytes(100), { status: 403 }), new Response(bytes(21))])
      await expect(Effect.runPromise(store.stage(response))).rejects.toThrow();
    const first = await Effect.runPromise(store.stage(new Response(bytes(23))));
    const second = await Effect.runPromise(store.stage(new Response(bytes(23))));
    expect(first.key).not.toBe(second.key);
    expect((await env.RUNS_STORAGE.list()).objects).toHaveLength(2);
  });
  it("refuses oversized transport chunks before retaining their bytes", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(256 * 1024 + 1)); c.close(); } });
    await expect(Effect.runPromise(makeNativeArchiveDownload(env.RUNS_STORAGE).stage(new Response(stream)))).rejects.toThrow();
    expect((await env.RUNS_STORAGE.list()).objects).toHaveLength(0);
  });
});
