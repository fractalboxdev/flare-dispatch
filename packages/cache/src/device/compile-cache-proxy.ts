// The extension host proxy's compile-cache handler (FD-CACHE-060): the device extension serves it to a job sandbox on
// the socket its `proxies(lease)` answer names, so sccache in the sandbox points `SCCACHE_WEBDAV_ENDPOINT` at it. It
// serves hits from L1 and forwards a miss and every write to the control plane's compile-cache route under the
// execution's token, which the sandbox never sees. An L1 copy is filed under the namespace the route reports, and
// only when that namespace is one the lease may read, so a pull request's object never answers a protected reader.
import { Effect } from "effect";
import { CACHE_NAMESPACE_HEADER, DEFAULT_MAX_COMPILE_OBJECT_BYTES } from "../compile-cache.ts";
import { sha256Hex } from "../crypto.ts";
import type { L1Cache } from "./l1.ts";

export interface CompileCacheProxyOptions {
  readonly l1: L1Cache;
  /** The lease's cache namespaces, in lookup order. */
  readonly read: readonly string[];
  readonly write: string | null;
  /** The upload grant's compile-cache access: the route for this repository and the execution's token. */
  readonly upstream: { readonly endpoint: string; readonly token: string };
  readonly fetch?: typeof globalThis.fetch;
  readonly maxObjectBytes?: number;
}

const SEGMENT = /^[A-Za-z0-9._+-]{1,255}$/;

/** The object path below the proxy's root, or `undefined` for an unsafe one; a trailing `/` marks a collection. */
const pathOf = (pathname: string) => {
  const raw = pathname.replace(/^\/+/, "");
  const collection = raw === "" || raw.endsWith("/");
  const segments = (collection ? raw.slice(0, -1) : raw).split("/").filter((s) => s !== "");
  if (segments.some((s) => !SEGMENT.test(s) || s === "." || s === "..")) return undefined;
  return { path: segments.join("/"), collection };
};

const xml = (href: string, props: string) =>
  new Response(
    `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${href.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`,
    { status: 207, headers: { "content-type": "application/xml; charset=utf-8" } },
  );

/** The handler the extension serves on the proxy socket. */
export const compileCacheProxy = (options: CompileCacheProxyOptions) => {
  const fetchUpstream = options.fetch ?? globalThis.fetch;
  const max = options.maxObjectBytes ?? DEFAULT_MAX_COMPILE_OBJECT_BYTES;
  const upstreamUrl = (path: string) => `${options.upstream.endpoint.replace(/\/$/, "")}/${path}`;
  const auth = { authorization: `Bearer ${options.upstream.token}` };
  const l1Key = (path: string) => sha256Hex(`compile-cache/${path}`);

  const fromL1 = async (path: string) => {
    const key = await l1Key(path);
    for (const namespace of options.read) {
      const bytes = await Effect.runPromise(options.l1.peek(namespace, key));
      if (bytes !== null) return bytes;
    }
    return null;
  };

  /** A forwarded request; a network failure is a miss, so sccache compiles locally (FD-CACHE-011). */
  const forward = async (path: string, init: RequestInit) => {
    try {
      return await fetchUpstream(upstreamUrl(path), { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) } });
    } catch {
      return new Response("compile cache unreachable", { status: 404 });
    }
  };

  return async (request: Request): Promise<Response> => {
    const parsed = pathOf(new URL(request.url).pathname);
    if (parsed === undefined) return new Response("not found", { status: 404 });
    const { path, collection } = parsed;
    switch (request.method) {
      case "MKCOL":
        return new Response(null, { status: 201 });
      case "PROPFIND": {
        if ((request.headers.get("depth") ?? "0").trim() !== "0") return new Response(null, { status: 403 });
        if (collection) return xml(`/${path}`, "<D:resourcetype><D:collection/></D:resourcetype>");
        const local = await fromL1(path);
        if (local !== null)
          return xml(`/${path}`, `<D:getcontentlength>${local.byteLength}</D:getcontentlength><D:resourcetype/>`);
        return forward(path, { method: "PROPFIND", headers: { depth: "0" } });
      }
      case "HEAD":
      case "GET": {
        if (collection) return new Response("not found", { status: 404 });
        const local = await fromL1(path);
        if (local !== null)
          return new Response(request.method === "HEAD" ? null : local, {
            headers: { "content-type": "application/octet-stream", "content-length": String(local.byteLength) },
          });
        const upstream = await forward(path, { method: request.method });
        if (request.method === "HEAD" || upstream.status !== 200) return upstream;
        const bytes = new Uint8Array(await upstream.arrayBuffer());
        const namespace = upstream.headers.get(CACHE_NAMESPACE_HEADER);
        if (namespace !== null && options.read.includes(namespace))
          await Effect.runPromise(options.l1.keep(namespace, await l1Key(path), bytes));
        return new Response(bytes, {
          headers: { "content-type": "application/octet-stream", "content-length": String(bytes.byteLength) },
        });
      }
      case "PUT": {
        if (collection) return new Response(null, { status: 405 });
        const declared = Number(request.headers.get("content-length") ?? Number.NaN);
        if (!Number.isSafeInteger(declared) || declared < 0) return new Response(null, { status: 411 });
        if (declared > max) return new Response(null, { status: 413 });
        if (options.write === null) return new Response("lease grants no writes", { status: 403 });
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.byteLength !== declared) return new Response(null, { status: 400 });
        const upstream = await forward(path, {
          method: "PUT",
          body: bytes,
          headers: { "content-length": String(bytes.byteLength) },
        });
        // L1 keeps the object only once the route stored it, so L1 never holds what the control plane refused.
        if (upstream.status === 201) await Effect.runPromise(options.l1.keep(options.write, await l1Key(path), bytes));
        return new Response(null, { status: upstream.status });
      }
      default:
        return new Response(null, { status: 405, headers: { allow: "GET, HEAD, PUT, PROPFIND, MKCOL" } });
    }
  };
};
