// `/v1/compile-cache/<owner>/<name>/<path>`: the WebDAV endpoint sccache's backend uses (FD-CACHE-056). sccache
// (OpenDAL `services-webdav`) issues GET (404 is a miss), PUT with `Content-Length`, PROPFIND `Depth: 0` of an
// entry's parent before each PUT, and MKCOL; collections are virtual, so every path ending in `/` exists.
//
// Objects live at `compile-cache/<namespace>/<path>`. The namespaces come from the verified token only, never the
// request path or headers (FD-CACHE-058): a PUT writes the token's writable namespace, and a GET tries its readable
// namespaces in token order, so a pull request's objects reach only that pull request. The route streams each GET and
// PUT body between the caller and R2 without buffering it (FD-CACHE-047).
import type { CacheLedgers } from "./ledger.ts";
import { DEFAULT_LEDGER_BOUNDS, MiB, type LedgerBounds } from "./ledger.ts";
import { verifyCompileCacheToken } from "./compile-cache-token.ts";
import type { Bucket } from "./manifest.ts";
import { CONTENT_NAMESPACE } from "./namespaces.ts";

export const COMPILE_CACHE_ROUTE = "/v1/compile-cache";
export const COMPILE_CACHE_PREFIX = "compile-cache/";
export const DEFAULT_MAX_COMPILE_OBJECT_BYTES = 100 * MiB;
export const DEFAULT_COMPILE_TTL_MS = 14 * 24 * 3600 * 1000;

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const SEGMENT = /^[A-Za-z0-9._+-]{1,255}$/;
const MAX_KEY_BYTES = 1024;
const ALLOW = "GET, HEAD, PUT, PROPFIND, MKCOL, OPTIONS";

export interface CompileCachePath {
  readonly repo: string;
  /** The path below the repository; ends in `/` for a collection. */
  readonly key: string;
  readonly collection: boolean;
}

/** Resolves a request path; `undefined` for an empty, `.` or `..` segment, a character outside the charset or a key over 1 KiB. */
export const parseCompileCachePath = (pathname: string): CompileCachePath | undefined => {
  if (!pathname.startsWith(`${COMPILE_CACHE_ROUTE}/`)) return undefined;
  const rest = pathname.slice(COMPILE_CACHE_ROUTE.length + 1);
  const collection = rest.endsWith("/");
  let segments: string[];
  try {
    segments = (collection ? rest.slice(0, -1) : rest).split("/").map(decodeURIComponent);
  } catch {
    return undefined;
  }
  const [owner, name, ...below] = segments;
  if (owner === undefined || name === undefined || !OWNER.test(owner) || !NAME.test(name))
    return undefined;
  if (name === "." || name === "..") return undefined;
  if (below.some((s) => !SEGMENT.test(s) || s === "." || s === "..")) return undefined;
  if (below.length === 0 && !collection) return undefined;
  const key = `${below.join("/")}${below.length > 0 && collection ? "/" : ""}`;
  if (new TextEncoder().encode(key).length > MAX_KEY_BYTES) return undefined;
  return { repo: `${owner}/${name}`.toLowerCase(), key, collection: collection || below.length === 0 };
};

export const compileObjectKey = (namespace: string, key: string) =>
  `${COMPILE_CACHE_PREFIX}${namespace}/${key}`;

export interface CompileCacheDeps {
  readonly bucket: Bucket;
  readonly ledgers: CacheLedgers;
  /** The secret compile-cache tokens derive from; without it every request is `503`. */
  readonly secret: string | undefined;
  readonly now: () => number;
  /** The execution's current epoch and whether it is terminal; a token for another epoch is refused (FD-CACHE-051). */
  readonly lease?: (
    executionId: string,
  ) => Promise<{ readonly epoch: number; readonly terminal: boolean } | null>;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  /** A stream of known length, which R2 stores; the Workers runtime's `FixedLengthStream` by default. */
  readonly fixedLength?: (stream: ReadableStream, length: number) => ReadableStream | undefined;
  readonly maxObjectBytes?: number;
  readonly bounds?: LedgerBounds;
  readonly ttlMs?: number;
}

const text = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });

const xmlEscape = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const multistatus = (href: string, props: string) =>
  new Response(
    `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`,
    { status: 207, headers: { "content-type": "application/xml; charset=utf-8" } },
  );

const workersFixedLength = (stream: ReadableStream, length: number) => {
  const Fixed = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream })
    .FixedLengthStream;
  if (Fixed === undefined) return undefined;
  const fixed = new Fixed(length);
  stream.pipeTo(fixed.writable).catch(() => undefined);
  return fixed.readable;
};

/**
 * Serves one compile-cache request. A missing, expired, malformed, forged or other-repository token is `403` and
 * touches no object (FD-CACHE-059). A PUT over the 100 MiB bound is `413` (FD-CACHE-053); it reserves its length in
 * the repository's `CacheLedger` before it writes (FD-CACHE-052), `507` past a bound (FD-CACHE-054) and `403` once the
 * execution is terminal (FD-CACHE-055). A GET of an object older than half the TTL rewrites it after the response, so
 * its age is its time since last read (FD-CACHE-061). A route failure is a miss to sccache, which compiles locally
 * (FD-CACHE-011).
 */
export const handleCompileCache = async (
  request: Request,
  deps: CompileCacheDeps,
): Promise<Response | null> => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${COMPILE_CACHE_ROUTE}/`)) return null;
  const path = parseCompileCachePath(url.pathname);
  if (path === undefined) return text(404, "not found");
  if (deps.secret === undefined || deps.secret === "")
    return text(503, "compile cache unavailable: no signing secret");
  const auth = request.headers.get("authorization");
  const bearer = auth === null ? null : (/^Bearer\s+(\S+)$/i.exec(auth.trim())?.[1] ?? null);
  const now = deps.now();
  const verdict = await verifyCompileCacheToken(deps.secret, path.repo, bearer, now);
  if (!verdict.ok) return text(403, `token ${verdict.reason}`);
  const scope = verdict.scope;
  if (deps.lease !== undefined) {
    const lease = await deps.lease(scope.executionId);
    if (lease === null || lease.epoch !== scope.epoch) return text(403, "token epoch is not current");
    if (lease.terminal && request.method === "PUT") return text(403, "execution is terminal");
  }
  const reads = scope.read.filter((n) => n !== CONTENT_NAMESPACE);
  const find = async <T>(read: (key: string) => Promise<T | null>) => {
    for (const namespace of reads) {
      const key = compileObjectKey(namespace, path.key);
      const object = await read(key);
      if (object !== null) return { key, object };
    }
    return null;
  };
  const headersOf = (o: R2Object) => ({
    "content-type": "application/octet-stream",
    "content-length": String(o.size),
    etag: o.httpEtag,
    "last-modified": o.uploaded.toUTCString(),
  });
  switch (request.method) {
    case "OPTIONS":
      return new Response(null, { status: 200, headers: { allow: ALLOW, dav: "1" } });
    case "HEAD": {
      if (path.collection) return text(404, "not found");
      const found = await find((k) => deps.bucket.head(k));
      return found === null
        ? text(404, "not found")
        : new Response(null, { status: 200, headers: headersOf(found.object) });
    }
    case "GET": {
      if (path.collection) return text(404, "not found");
      const found = await find((k) => deps.bucket.get(k));
      if (found === null) return text(404, "not found");
      const object = found.object;
      const ttl = deps.ttlMs ?? DEFAULT_COMPILE_TTL_MS;
      if (deps.waitUntil !== undefined && now - object.uploaded.getTime() > ttl / 2) {
        const [served, copied] = object.body.tee();
        const sized = (deps.fixedLength ?? workersFixedLength)(copied, object.size);
        if (sized === undefined) copied.cancel().catch(() => undefined);
        else
          deps.waitUntil(
            deps.bucket
              .put(found.key, sized, { httpMetadata: { contentType: "application/octet-stream" } })
              .catch(() => undefined),
          );
        return new Response(served, { status: 200, headers: headersOf(object) });
      }
      return new Response(object.body, { status: 200, headers: headersOf(object) });
    }
    case "PUT": {
      if (path.collection) return text(405, "a collection takes no body", { allow: ALLOW });
      const declared = request.headers.get("content-length");
      if (declared === null || !/^[0-9]{1,16}$/.test(declared))
        return text(411, "content-length required");
      const length = Number(declared);
      const max = deps.maxObjectBytes ?? DEFAULT_MAX_COMPILE_OBJECT_BYTES;
      if (length > max) return text(413, `object of ${length} bytes exceeds the ${max}-byte bound`);
      if (scope.write === null) return text(403, "token grants no writes");
      const reserved = await deps.ledgers(path.repo).reserve({
        executionId: scope.executionId,
        bytes: length,
        expiresAt: scope.expiresAt,
        immediate: true,
        bounds: deps.bounds ?? DEFAULT_LEDGER_BOUNDS,
      });
      if (!reserved.ok)
        return reserved.reason === "ended"
          ? text(403, "execution is terminal")
          : text(507, `CacheLedger refused: ${reserved.reason} bound`);
      const stored = await deps.bucket.put(
        compileObjectKey(scope.write, path.key),
        length === 0 || request.body === null ? "" : request.body,
        { httpMetadata: { contentType: "application/octet-stream" } },
      );
      return new Response(null, {
        status: 201,
        headers: stored === null ? {} : { etag: stored.httpEtag },
      });
    }
    case "MKCOL":
      return new Response(null, { status: 201 });
    case "PROPFIND": {
      const depth = request.headers.get("depth");
      if (depth !== null && depth.trim() !== "0") return text(403, "only Depth: 0 is served");
      const href = xmlEscape(url.pathname);
      if (path.collection)
        return multistatus(
          href,
          `<D:getlastmodified>${new Date(0).toUTCString()}</D:getlastmodified><D:resourcetype><D:collection/></D:resourcetype>`,
        );
      const found = await find((k) => deps.bucket.head(k));
      if (found === null) return text(404, "not found");
      const o = found.object;
      return multistatus(
        href,
        `<D:getlastmodified>${o.uploaded.toUTCString()}</D:getlastmodified><D:getcontentlength>${o.size}</D:getcontentlength><D:getetag>${xmlEscape(o.httpEtag)}</D:getetag><D:resourcetype/>`,
      );
    }
    default:
      return text(405, "method not allowed", { allow: ALLOW });
  }
};
