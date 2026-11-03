// The object-store presigner (specs/cache-artifacts.md § Presigned URLs and byte bounds). Cache objects, artifacts and
// logs move between an executor and R2 only through URLs it signs (FD-CACHE-047); the control plane decides which
// object, which method and how long before it signs anything.
import { ObjectStorePresigner } from "@fractalboxdev/mameko-ports";
import { Context, Effect, Layer, Schema } from "effect";
import { CacheClock, CacheLeases, DEFAULT_BYTE_BOUNDS, type ByteBounds } from "./lease.ts";
import { CacheBucket, Ledgers, objectPrefix, readManifest, refreshLastRead } from "./manifest.ts";
import { CONTENT_NAMESPACE } from "./namespaces.ts";
import { amzDateOf, presignV4 } from "./sigv4.ts";
import { parseLogObjectName } from "./logs.ts";

/** A URL lives at most 15 min (FD-CACHE-048, FD-CACHE-051). */
export const MAX_URL_LIFETIME_MS = 15 * 60 * 1000;

export interface PresignRequest {
  readonly key: string;
  readonly method: "GET" | "PUT";
  /** The declared `Content-Length` a `PUT` signs; `null` for a `GET`. */
  readonly length: number | null;
  readonly expiresAt: number;
  /** Extra signed query parameters: `partNumber` and `uploadId` of a multipart part. */
  readonly query?: Readonly<Record<string, string>>;
}

/** FlareDispatch's signer: one object key, one method, one expiry, optional multipart part parameters. */
export interface R2PresignerService {
  readonly presign: (
    request: PresignRequest,
  ) => Effect.Effect<{ readonly url: string; readonly expiresAt: number }>;
}

export class R2Presigner extends Context.Service<R2Presigner, R2PresignerService>()(
  "@fractalboxdev/flare-dispatch-cache/R2Presigner",
) {}

export interface R2PresignerConfig {
  /** The Cloudflare account id: the S3 endpoint is `<account_id>.r2.cloudflarestorage.com` (FD-CACHE-091). */
  readonly accountId: string;
  readonly bucket: string;
  /** An R2 API token scoped to the cache and artifact buckets with Object Read & Write, used for nothing else. */
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * The live signer: SigV4 query presigning on the bucket's S3 endpoint, never a custom domain, because presigned URLs
 * do not work on one (FD-CACHE-091). A `PUT` signs its `Content-Length` (FD-CACHE-049).
 */
export const r2Presigner = (config: R2PresignerConfig, now: () => number): R2PresignerService => ({
  presign: (request) =>
    Effect.promise(async () => {
      const at = now();
      const expiresSec = Math.max(1, Math.floor((request.expiresAt - at) / 1000));
      const url = await presignV4({
        method: request.method,
        host: `${config.accountId}.r2.cloudflarestorage.com`,
        path: `/${config.bucket}/${request.key}`,
        ...(request.query === undefined ? {} : { query: request.query }),
        ...(request.method === "PUT" && request.length !== null
          ? { headers: { "content-length": String(request.length) } }
          : {}),
        region: "auto",
        service: "s3",
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        amzDate: amzDateOf(at),
        expiresSec,
      });
      return { url, expiresAt: at + expiresSec * 1000 };
    }),
});

export const R2PresignerLive = (config: R2PresignerConfig) =>
  Layer.effect(
    R2Presigner,
    Effect.gen(function* () {
      const clock = yield* CacheClock;
      return r2Presigner(config, clock.now);
    }),
  );

/** mameko's object-store presigner port (MAMEKO-HOST-048), answered by FlareDispatch's signer. */
export const ObjectStorePresignerLive = Layer.effect(
  ObjectStorePresigner,
  Effect.gen(function* () {
    const signer = yield* R2Presigner;
    return {
      presign: (key: string, method: "GET" | "PUT", length: number | null, expiresAt: number) =>
        signer.presign({ key, method, length, expiresAt }),
    };
  }),
);

// ---- The policy before signing -------------------------------------------------------

/** A URL request the control plane refuses; `status` is the HTTP status (FD-CACHE-053, FD-CACHE-054, FD-CACHE-055). */
export class PresignRefused extends Schema.TaggedError<PresignRefused>()("PresignRefused", {
  status: Schema.Number,
  key: Schema.String,
  reason: Schema.String,
}) {}

export type PresignAnswer =
  | {
      readonly urls: readonly {
        readonly key: string;
        readonly url: string;
        readonly expires_at: number;
      }[];
    }
  | { readonly status: "stale" };

/** A cache object path split into its namespace, key and writer segment, or `undefined` outside the grammar. */
export const parseCacheObjectPath = (path: string) => {
  if (!path.startsWith("cache/")) return undefined;
  const parts = path.slice("cache/".length).split("/");
  const width = parts[0] === "cas" ? 2 : 4;
  if (parts.length < width + 3) return undefined;
  if (parts.some((p) => p === "" || p === "." || p === "..")) return undefined;
  const namespace = parts.slice(0, width).join("/");
  const key = parts[width]!;
  const writer = /^(.+)\.([1-9][0-9]*)$/.exec(parts[width + 1]!);
  if (writer === null || !/^[0-9a-f]{64}$/.test(key)) return undefined;
  return { namespace, key, executionId: writer[1]!, epoch: Number(writer[2]) };
};

const readableBy = (read: readonly string[], namespace: string) =>
  read.includes(namespace) || (namespace.startsWith("cas/") && read.includes(CONTENT_NAMESPACE));

/**
 * Answers `exec.presign`. A request whose epoch is not the execution's current epoch is `stale`, so a reclaimed or
 * revoked lease's executor gets no further URL (FD-CACHE-051). Otherwise every object is checked before any is signed:
 * - a `GET` only of an object a committed manifest of a readable namespace lists (FD-CACHE-050), refreshing the
 *   entry's `last_read_at` once older than half the TTL (FD-CACHE-061);
 * - a `PUT` only under the writable namespace and current epoch, or under the execution's log path at this epoch,
 *   with a declared length (FD-CACHE-049); over the per-object bound it is `413` (FD-CACHE-053); after the execution
 *   is terminal, `403` (FD-CACHE-055); each declared length is reserved in the repository's `CacheLedger` before its
 *   URL is minted (FD-CACHE-052), and a reservation over a bound is `507` (FD-CACHE-054);
 * - each URL expires at the earlier of 15 min after minting and `deadline_at` (FD-CACHE-048);
 * - a `confidential-compute` repository gets no L2 URL (FD-CACHE-008).
 */
export const presignForExecution = (
  frame: {
    readonly execution_id: string;
    readonly epoch: number;
    readonly objects: readonly {
      readonly key: string;
      readonly method: "GET" | "PUT";
      readonly length: number | null;
    }[];
  },
  bounds: ByteBounds = DEFAULT_BYTE_BOUNDS,
) =>
  Effect.gen(function* () {
    const lease = yield* (yield* CacheLeases).current(frame.execution_id);
    const bucket = yield* CacheBucket;
    const ledgers = yield* Ledgers;
    const signer = yield* R2Presigner;
    const now = (yield* CacheClock).now();
    if (lease === null || lease.epoch !== frame.epoch) return { status: "stale" } as PresignAnswer;
    const refuse = (status: number, key: string, reason: string) =>
      Effect.fail(new PresignRefused({ status, key, reason }));
    const expiresAt = Math.min(now + MAX_URL_LIFETIME_MS, lease.deadlineAt);
    if (expiresAt <= now) return yield* refuse(403, "", "past the execution's deadline");
    for (const object of frame.objects) {
      if (lease.confidential === true)
        return yield* refuse(403, object.key, "confidential-compute keeps the cache on the device");
      if (object.method === "GET") {
        const parsed = parseCacheObjectPath(object.key);
        if (parsed === undefined || !readableBy(lease.namespaces.read, parsed.namespace))
          return yield* refuse(403, object.key, "not in a readable namespace");
        const read = yield* readManifest(bucket, parsed.namespace, parsed.key);
        if (read === null || !read.manifest.objects.some((o) => o.path === object.key))
          return yield* refuse(404, object.key, "no committed manifest lists the object");
        yield* refreshLastRead(bucket, read, now).pipe(Effect.ignore);
        continue;
      }
      if (lease.status === "terminal") return yield* refuse(403, object.key, "execution is terminal");
      if (object.length === null || !Number.isSafeInteger(object.length) || object.length < 0)
        return yield* refuse(411, object.key, "a PUT declares its length");
      if (object.length > bounds.maxObjectBytes)
        return yield* refuse(413, object.key, `over the ${bounds.maxObjectBytes}-byte object bound`);
      if (!writableBy(lease, object.key))
        return yield* refuse(403, object.key, "outside the writable namespace and epoch");
    }
    for (const object of frame.objects) {
      if (object.method !== "PUT" || object.key.startsWith("logs/")) continue;
      const reserved = yield* Effect.promise(() =>
        ledgers(lease.repo).reserve({
          executionId: lease.executionId,
          bytes: object.length ?? 0,
          expiresAt: lease.deadlineAt,
        }),
      );
      if (!reserved.ok)
        return yield* refuse(
          reserved.reason === "ended" ? 403 : 507,
          object.key,
          `CacheLedger refused: ${reserved.reason} bound`,
        );
    }
    const urls = [];
    for (const object of frame.objects) {
      const signed = yield* signer.presign({
        key: object.key,
        method: object.method,
        length: object.length,
        expiresAt,
      });
      urls.push({ key: object.key, url: signed.url, expires_at: signed.expiresAt });
    }
    return { urls } as PresignAnswer;
  });

const writableBy = (
  lease: { readonly namespaces: { readonly write: string | null }; readonly executionId: string; readonly epoch: number },
  key: string,
): boolean => {
  if (key.startsWith("logs/")) {
    const log = parseLogObjectName(key);
    return log !== undefined && log.executionId === lease.executionId && log.epoch === lease.epoch;
  }
  const parsed = parseCacheObjectPath(key);
  if (parsed === undefined || lease.namespaces.write === null) return false;
  return (
    parsed.namespace === lease.namespaces.write &&
    key.startsWith(objectPrefix(parsed.namespace, parsed.key, lease.executionId, lease.epoch))
  );
};
