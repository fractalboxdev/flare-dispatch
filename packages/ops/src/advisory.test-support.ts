// An OSV archive server, a content-addressed bucket and a Node SHA-256 reader for the advisory refresh suites: the
// server answers each ecosystem's `all.zip` from what the suite publishes, and can fail, truncate or change it between
// reads; the bucket refuses bytes whose SHA-256 or length is not what the put names, as R2 does.
import { createHash } from "node:crypto";
import { osvArchiveUrl, type AdvisoryRefreshPorts, type AdvisoryResponse } from "./advisory.ts";

/** One published archive and how the server answers it. */
export interface Published {
  readonly bytes: Uint8Array;
  readonly lastModified: number;
  /** A status other than 200, or a GET that throws. */
  readonly status?: number | "throws";
  /** A body holding fewer bytes than `Content-Length` names. */
  readonly truncate?: number;
  readonly omitContentLength?: boolean;
  readonly omitLastModified?: boolean;
  /** The archive the second read answers, as when OSV publishes between the digest read and the store. */
  readonly next?: Published;
}

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export const archive = (text: string): Uint8Array => new TextEncoder().encode(`PK\u0003\u0004${text}`);

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      // Several chunks, so the readers count across chunk boundaries.
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  });

const readAll = async (body: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};

/** The OSV server: `published` by ecosystem, each GET recorded by URL. */
export const osvServer = (published: Map<string, Published>) => {
  const gets: string[] = [];
  const reads = new Map<string, number>();
  const fetch = async (url: string): Promise<AdvisoryResponse> => {
    gets.push(url);
    const ecosystem = [...published.keys()].find((e) => osvArchiveUrl(e) === url);
    if (ecosystem === undefined) return { status: 404, headers: new Headers(), body: null };
    const n = reads.get(ecosystem) ?? 0;
    reads.set(ecosystem, n + 1);
    const first = published.get(ecosystem)!;
    const p = n > 0 && first.next !== undefined ? first.next : first;
    if (p.status === "throws") throw new Error("connection reset");
    const headers = new Headers();
    if (!p.omitContentLength) headers.set("content-length", String(p.bytes.length));
    if (!p.omitLastModified) headers.set("last-modified", new Date(p.lastModified).toUTCString());
    const body = p.bytes.slice(0, p.truncate ?? p.bytes.length);
    return { status: p.status ?? 200, headers, body: streamOf(body) };
  };
  return { fetch, gets };
};

/** A content-addressed bucket that refuses a put whose bytes' SHA-256 or length differs from what it names. */
export const casBucket = (
  options: { readonly keepShort?: boolean; readonly refuse?: (key: string) => boolean } = {},
) => {
  const objects = new Map<string, Uint8Array>();
  const puts: string[] = [];
  const bucket: AdvisoryRefreshPorts["bucket"] = {
    head: async (key) => {
      const o = objects.get(key);
      return o === undefined ? null : { size: o.length };
    },
    put: async (key, body, expected) => {
      puts.push(key);
      const bytes = await readAll(body);
      if (options.refuse?.(key)) throw new Error("R2 answered 500");
      if (options.keepShort) {
        objects.set(key, bytes.slice(0, bytes.length - 1));
        return { size: bytes.length - 1 };
      }
      if (bytes.length !== expected.length || sha256(bytes) !== expected.sha256)
        throw new Error("the body's checksum or length differs from the put's");
      objects.set(key, bytes);
      return { size: bytes.length };
    },
  };
  return { bucket, objects, puts };
};

/** A Node reader of a stream's SHA-256 and length. */
export const nodeSha256 = async (body: ReadableStream<Uint8Array>) => {
  const bytes = await readAll(body);
  return { digest: sha256(bytes), bytes: bytes.length };
};

/** The refresh's ports over `server` and `bucket`. */
export const refreshPorts = (
  server: ReturnType<typeof osvServer>,
  bucket: ReturnType<typeof casBucket>,
): AdvisoryRefreshPorts => ({ fetch: server.fetch, sha256: nodeSha256, bucket: bucket.bucket });
