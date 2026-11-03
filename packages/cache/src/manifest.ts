// Cache entries (specs/cache-artifacts.md § Cache entries; § Entries, commit and verification). An entry is a set of
// immutable objects under `cache/<namespace>/<key>/<execution_id>.<epoch>/` plus one manifest at
// `cache/<namespace>/<key>/manifest.json`, which the control plane writes last with a create-only conditional put.
// Objects without a committed manifest are never restored, so a torn write or a stale epoch's upload never becomes an
// entry. `last_read_at` lives in the manifest object's custom metadata, outside the signed body, so a refresh
// rewrites no signed byte.
import type { ExecutorKind } from "@fractalboxdev/mameko-kernel";
import { Context, Effect, Option, Schema } from "effect";
import { asBuffer, base64url, canonicalJson, fromBase64url, utf8 } from "./crypto.ts";
import type { CacheLedgers } from "./ledger.ts";
import { CacheClock, CacheLeases } from "./lease.ts";
import { isCloudKind, restoresNothing, tierOf, type CacheNamespaces } from "./namespaces.ts";

export const ManifestObject = Schema.Struct({
  path: Schema.String,
  size: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});
export type ManifestObject = typeof ManifestObject.Type;

export const Signature = Schema.Struct({
  alg: Schema.Literal("ES256"),
  /** `control-plane` for a cloud writer; the device's executor id for a device writer. */
  key_id: Schema.String,
  value: Schema.String,
});

/** A committed manifest (FD-CACHE-042). */
export const Manifest = Schema.Struct({
  key: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  namespace: Schema.String,
  tier: Schema.Literals([
    "protected-cloud",
    "protected-device",
    "pull-request",
    "execution",
    "content",
  ]),
  writer: Schema.Struct({
    executor_id: Schema.String,
    executor_kind: Schema.String,
    execution_id: Schema.String,
    epoch: Schema.Number,
  }),
  objects: Schema.Array(ManifestObject),
  created_at: Schema.Number,
  signature: Signature,
});
export type Manifest = typeof Manifest.Type;

/** What the executor sends in `exec.cache.commit`: the control plane records the writer, tier and time itself. */
export const CommitRequest = Schema.Struct({
  key: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  namespace: Schema.String,
  objects: Schema.Array(ManifestObject).check(Schema.isMinLength(1)),
  /** A device writer's signature over the manifest body under the `cache-entry` purpose (FD-CACHE-043). */
  signature: Schema.optionalKey(Schema.String),
});
export type CommitRequest = typeof CommitRequest.Type;

export const entryPrefix = (namespace: string, key: string) => `cache/${namespace}/${key}/`;
export const manifestPath = (namespace: string, key: string) =>
  `${entryPrefix(namespace, key)}manifest.json`;
/** Where one writer's objects for an entry go (FD-CACHE-039). */
export const objectPrefix = (namespace: string, key: string, executionId: string, epoch: number) =>
  `${entryPrefix(namespace, key)}${executionId}.${epoch}/`;

/** The signed bytes: the canonical JSON of the manifest without its signature. */
export const signedBody = (manifest: Omit<Manifest, "signature">) =>
  canonicalJson({ ...manifest, signature: undefined });

// ---- Signing -------------------------------------------------------------------

export interface ManifestSignerService {
  /** Signs a cloud writer's manifest body with the control plane's cache-signing key (FD-CACHE-043). */
  readonly sign: (body: string) => Effect.Effect<Manifest["signature"]>;
  /** The device's registered public key (SPKI, base64) for the `cache-entry` purpose, or null when none. */
  readonly deviceKey: (executorId: string) => Effect.Effect<string | null>;
}

export class ManifestSigner extends Context.Service<ManifestSigner, ManifestSignerService>()(
  "@fractalboxdev/flare-dispatch-cache/ManifestSigner",
) {}

const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const ES256 = { name: "ECDSA", hash: "SHA-256" } as const;

/** The control plane's cache-signing key from an ES256 private JWK, as the `CACHE_SIGNING_JWK` secret holds it. */
export const importCacheSigningKey = (jwk: JsonWebKey) =>
  crypto.subtle.importKey("jwk", jwk, ECDSA, false, ["sign"]);

export const es256Sign = async (key: CryptoKey, body: string) =>
  base64url(await crypto.subtle.sign(ES256, key, asBuffer(utf8(body))));

/** Verifies an ES256 signature with a public key given as a JWK or as base64 SPKI. */
export const es256Verify = async (
  publicKey: JsonWebKey | string,
  body: string,
  signature: string,
): Promise<boolean> => {
  const sig = fromBase64url(signature);
  if (sig === undefined) return false;
  try {
    const key =
      typeof publicKey === "string"
        ? await crypto.subtle.importKey(
            "spki",
            asBuffer(Uint8Array.from(atob(publicKey), (c) => c.charCodeAt(0))),
            ECDSA,
            false,
            ["verify"],
          )
        : await crypto.subtle.importKey("jwk", publicKey, ECDSA, false, ["verify"]);
    return await crypto.subtle.verify(ES256, key, asBuffer(sig), asBuffer(utf8(body)));
  } catch {
    return false;
  }
};

// ---- The bucket ------------------------------------------------------------------

/** The R2 surface the cache, artifact and log stores use. */
export type Bucket = Pick<
  R2Bucket,
  "get" | "head" | "put" | "delete" | "list" | "createMultipartUpload" | "resumeMultipartUpload"
>;

export class CacheBucket extends Context.Service<CacheBucket, Bucket>()(
  "@fractalboxdev/flare-dispatch-cache/CacheBucket",
) {}

export class Ledgers extends Context.Service<Ledgers, CacheLedgers>()(
  "@fractalboxdev/flare-dispatch-cache/Ledgers",
) {}

// ---- Commit ------------------------------------------------------------------------

export class CacheNamespaceDenied extends Schema.TaggedError<CacheNamespaceDenied>()(
  "CacheNamespaceDenied",
  { namespace: Schema.String, writable: Schema.NullOr(Schema.String) },
) {}

/** A commit the control plane refuses for a reason other than the namespace; `status` is the HTTP status it maps to. */
export class CommitRefused extends Schema.TaggedError<CommitRefused>()("CommitRefused", {
  status: Schema.Number,
  reason: Schema.String,
}) {}

/** `exec.cache.commit.ack`'s statuses. */
export type CommitAck = "accepted" | "duplicate" | "stale";

const decodeCommit = Schema.decodeUnknownOption(CommitRequest);
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest));

/**
 * Commits one cache manifest from `exec.cache.commit`:
 * - a frame whose epoch is not the execution's current epoch is `stale` (FD-CACHE-040);
 * - a terminal execution's commit is refused with `403` (FD-CACHE-055);
 * - a namespace other than the lease's writable namespace fails with `CacheNamespaceDenied` (FD-CACHE-029);
 * - every object must sit under the writer's `<execution_id>.<epoch>/` path and be uploaded at its declared size
 *   before the manifest commits (FD-CACHE-039);
 * - the control plane records key, namespace, tier, writer, epoch, time and every object (FD-CACHE-042), signs a cloud
 *   writer's manifest and accepts a device writer's only with a valid signature by its registered key (FD-CACHE-043);
 * - the manifest goes to R2 with `onlyIf: { etagDoesNotMatch: "*" }`, and a `null` result is an existing manifest,
 *   answered `duplicate` (FD-CACHE-041).
 */
export const commitCacheManifest = (frame: {
  readonly execution_id: string;
  readonly epoch: number;
  readonly manifest: unknown;
}) =>
  Effect.gen(function* () {
    const leases = yield* CacheLeases;
    const bucket = yield* CacheBucket;
    const ledgers = yield* Ledgers;
    const signer = yield* ManifestSigner;
    const clock = yield* CacheClock;
    const lease = yield* leases.current(frame.execution_id);
    if (lease === null || lease.epoch !== frame.epoch) return "stale" as CommitAck;
    if (lease.status === "terminal")
      return yield* Effect.fail(new CommitRefused({ status: 403, reason: "execution is terminal" }));
    const request = Option.getOrUndefined(decodeCommit(frame.manifest));
    if (request === undefined)
      return yield* Effect.fail(new CommitRefused({ status: 400, reason: "malformed manifest" }));
    if (request.namespace !== lease.namespaces.write)
      return yield* Effect.fail(
        new CacheNamespaceDenied({
          namespace: request.namespace,
          writable: lease.namespaces.write,
        }),
      );
    const tier = tierOf(request.namespace);
    if (tier === undefined)
      return yield* Effect.fail(new CommitRefused({ status: 400, reason: "unknown namespace" }));
    const prefix = objectPrefix(request.namespace, request.key, lease.executionId, lease.epoch);
    for (const object of request.objects) {
      if (!object.path.startsWith(prefix) || object.path.slice(prefix.length).includes(".."))
        return yield* Effect.fail(
          new CommitRefused({ status: 400, reason: `object ${object.path} is outside ${prefix}` }),
        );
      const stored = yield* Effect.promise(() => bucket.head(object.path));
      if (stored === null || stored.size !== object.size)
        return yield* Effect.fail(
          new CommitRefused({ status: 409, reason: `object ${object.path} is not uploaded` }),
        );
    }
    const body = {
      key: request.key,
      namespace: request.namespace,
      tier,
      writer: {
        executor_id: lease.executorId,
        executor_kind: lease.executorKind,
        execution_id: lease.executionId,
        epoch: lease.epoch,
      },
      objects: request.objects,
      created_at: clock.now(),
    } satisfies Omit<Manifest, "signature">;
    const signature =
      lease.executorKind === "device"
        ? yield* deviceSignature(signer, lease.executorId, body, request.signature)
        : yield* signer.sign(signedBody(body));
    const manifest: Manifest = { ...body, signature };
    const written = yield* Effect.promise(() =>
      bucket.put(manifestPath(request.namespace, request.key), JSON.stringify(manifest), {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" },
        customMetadata: { last_read_at: String(body.created_at) },
      }),
    );
    if (written === null) return "duplicate" as CommitAck;
    yield* Effect.promise(() =>
      ledgers(lease.repo).commit({
        executionId: lease.executionId,
        bytes: request.objects.reduce((sum, o) => sum + o.size, 0),
      }),
    );
    return "accepted" as CommitAck;
  });

const deviceSignature = (
  signer: ManifestSignerService,
  executorId: string,
  body: Omit<Manifest, "signature">,
  presented: string | undefined,
) =>
  Effect.gen(function* () {
    const key = yield* signer.deviceKey(executorId);
    if (key === null || presented === undefined)
      return yield* Effect.fail(
        new CommitRefused({ status: 403, reason: "device manifest needs a cache-entry signature" }),
      );
    const valid = yield* Effect.promise(() => es256Verify(key, signedBody(body), presented));
    if (!valid)
      return yield* Effect.fail(
        new CommitRefused({ status: 403, reason: "cache-entry signature does not verify" }),
      );
    return { alg: "ES256" as const, key_id: executorId, value: presented };
  });

// ---- Reading ---------------------------------------------------------------------

/** Reads and decodes a committed manifest with its `last_read_at` and etag; `null` when none is committed. */
export const readManifest = (bucket: Bucket, namespace: string, key: string) =>
  Effect.gen(function* () {
    const object = yield* Effect.promise(() => bucket.get(manifestPath(namespace, key)));
    if (object === null) return null;
    const text = yield* Effect.promise(() => object.text());
    const manifest = Option.getOrUndefined(decodeManifest(text));
    if (manifest === undefined) return null;
    const lastReadAt = Number(object.customMetadata?.last_read_at ?? manifest.created_at);
    return { manifest, lastReadAt, etag: object.etag, text };
  });

export const DEFAULT_CACHE_TTL_MS = 14 * 24 * 3600 * 1000;

/**
 * Sets `last_read_at` to `nowMs` when a restore reads an entry last read more than half the TTL ago (FD-CACHE-061).
 * The rewrite is conditional on the etag read, so a concurrent refresh or delete wins.
 */
export const refreshLastRead = (
  bucket: Bucket,
  read: { readonly manifest: Manifest; readonly lastReadAt: number; readonly etag: string; readonly text: string },
  nowMs: number,
  ttlMs: number = DEFAULT_CACHE_TTL_MS,
) =>
  nowMs - read.lastReadAt <= ttlMs / 2
    ? Effect.succeed(false)
    : Effect.promise(() =>
        bucket.put(manifestPath(read.manifest.namespace, read.manifest.key), read.text, {
          onlyIf: { etagMatches: read.etag },
          httpMetadata: { contentType: "application/json" },
          customMetadata: { last_read_at: String(nowMs) },
        }),
      ).pipe(Effect.map((written) => written !== null));

/** The keys a reader verifies signatures against. */
export interface VerificationKeys {
  /** The control plane's cache-signing public key. */
  readonly controlPlane: JsonWebKey;
  /** A device's registered `cache-entry` public key, base64 SPKI. */
  readonly device: (executorId: string) => string | null;
}

/** The reader's context: its lease's namespaces, its class and constraints, and the executor kind it runs on. */
export interface ReaderContext {
  readonly namespaces: CacheNamespaces;
  readonly class: string;
  readonly constraints: readonly string[];
  readonly executorKind: ExecutorKind;
}

export interface CacheHit {
  readonly namespace: string;
  readonly manifest: Manifest;
}

/** Verifies a manifest's signature against the key of its writer. */
export const verifyManifest = (manifest: Manifest, keys: VerificationKeys): Promise<boolean> => {
  const { signature, ...body } = manifest;
  const writerKey =
    manifest.writer.executor_kind === "device"
      ? keys.device(manifest.writer.executor_id)
      : keys.controlPlane;
  if (writerKey === null) return Promise.resolve(false);
  if (manifest.writer.executor_kind === "device" && signature.key_id !== manifest.writer.executor_id)
    return Promise.resolve(false);
  return es256Verify(writerKey, signedBody(body), signature.value);
};

/**
 * Looks a key up across the lease's readable namespaces in lease order, so a pull-request execution tries its own
 * namespace first (FD-CACHE-024). A namespace without a committed manifest is a miss there, whatever objects it holds
 * (FD-CACHE-044); a manifest whose signature fails verification is a miss, logged as `cache.verify_failed`
 * (FD-CACHE-045); a `required` execution on a cloud executor skips a manifest a device wrote (FD-CACHE-027); a
 * `release` or `cloud-only` execution restores nothing (FD-CACHE-028). Any read failure is a miss and the run goes on
 * (FD-CACHE-011).
 */
export const lookupEntry = (
  reader: ReaderContext,
  key: string,
  fetchManifest: (namespace: string, key: string) => Promise<Manifest | null>,
  keys: VerificationKeys,
): Effect.Effect<CacheHit | null> =>
  Effect.gen(function* () {
    if (restoresNothing(reader)) return null;
    const cloudRequired = reader.class === "required" && isCloudKind(reader.executorKind);
    for (const namespace of reader.namespaces.read) {
      const manifest = yield* Effect.tryPromise(() => fetchManifest(namespace, key)).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (manifest === null || manifest.key !== key || manifest.namespace !== namespace) continue;
      if (cloudRequired && !isCloudKind(manifest.writer.executor_kind)) continue;
      const valid = yield* Effect.tryPromise(() => verifyManifest(manifest, keys)).pipe(
        Effect.orElseSucceed(() => false),
      );
      if (!valid) {
        yield* logVerifyFailed(key, manifest.writer.executor_id);
        continue;
      }
      return { namespace, manifest };
    }
    return null;
  });

const logVerifyFailed = (key: string, writer: string) =>
  Effect.logWarning("cache.verify_failed").pipe(
    Effect.annotateLogs({ key, writer_executor_id: writer }),
  );

/**
 * Downloads every object of a hit and checks each SHA-256 against the manifest; a mismatch or a failed fetch is a
 * miss, logged as `cache.verify_failed` on a mismatch (FD-CACHE-045, FD-CACHE-011).
 */
export const restoreObjects = (
  hit: CacheHit,
  fetchObject: (path: string) => Promise<Uint8Array>,
  sha256: (bytes: Uint8Array) => Promise<string>,
): Effect.Effect<ReadonlyMap<string, Uint8Array> | null> =>
  Effect.gen(function* () {
    const restored = new Map<string, Uint8Array>();
    for (const object of hit.manifest.objects) {
      const bytes = yield* Effect.tryPromise(() => fetchObject(object.path)).pipe(Effect.option);
      if (Option.isNone(bytes)) return null;
      const digest = yield* Effect.promise(() => sha256(bytes.value));
      if (digest !== object.sha256 || bytes.value.byteLength !== object.size) {
        yield* logVerifyFailed(hit.manifest.key, hit.manifest.writer.executor_id);
        return null;
      }
      restored.set(object.path, bytes.value);
    }
    return restored;
  });

/** What the `save` primitive reports: the write is skipped, done, or failed and logged; none of them fails the run. */
export type SaveOutcome = "skipped-existing" | "saved" | "failed";

/**
 * The `save` primitive: it checks for a committed manifest for the key and skips the upload when one exists
 * (FD-CACHE-046), otherwise uploads every object and then commits the manifest (FD-CACHE-039). A failure at any step
 * is logged with the key and the run continues with its verdict unchanged (FD-CACHE-012).
 */
export const saveEntry = <E1, E2, E3>(steps: {
  readonly key: string;
  readonly committed: Effect.Effect<boolean, E1>;
  readonly upload: Effect.Effect<void, E2>;
  readonly commit: Effect.Effect<CommitAck, E3>;
}): Effect.Effect<SaveOutcome> =>
  Effect.gen(function* () {
    if (yield* steps.committed) return "skipped-existing" as SaveOutcome;
    yield* steps.upload;
    const ack = yield* steps.commit;
    return (ack === "accepted" ? "saved" : ack === "duplicate" ? "skipped-existing" : "failed") as SaveOutcome;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("cache.save_failed", cause).pipe(
        Effect.annotateLogs({ key: steps.key }),
        Effect.as("failed" as SaveOutcome),
      ),
    ),
  );
