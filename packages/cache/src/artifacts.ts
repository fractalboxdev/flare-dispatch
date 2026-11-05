// The artifact store (specs/cache-artifacts.md § Artifacts). An artifact is stored at
// `artifacts/<execution_id>/<epoch>/<name>` and described by one D1 row; the `artifact_id` is the public handle and
// the R2 path is never exposed. A browse expansion's files sit under `<path>.browse/`.
import type { ExecutorKind } from "@fractalboxdev/mameko-kernel";
import { Context, Effect, Schema } from "effect";
import { random128 } from "./crypto.ts";
import { CacheClock, CacheLeases, DEFAULT_BYTE_BOUNDS, type ByteBounds } from "./lease.ts";
import { signCapability, verifyCapability } from "./logs.ts";
import { CacheBucket } from "./manifest.ts";
import { MAX_URL_LIFETIME_MS, R2Presigner } from "./presign.ts";
import { MiB } from "./ledger.ts";

export const ARTIFACT_SCHEMA = [
  `create table if not exists artifacts (
    artifact_id text primary key,
    execution_id text not null,
    epoch integer not null,
    name text not null,
    size integer not null,
    sha256 text not null,
    content_type text not null,
    producer_executor_id text not null,
    producer_executor_kind text not null,
    repo text not null,
    private integer not null,
    r2_path text,
    browse integer not null default 0,
    created_at integer not null,
    expires_at integer not null,
    unique (execution_id, epoch, name)
  )`,
  "create index if not exists artifacts_execution on artifacts (execution_id, artifact_id)",
  "create index if not exists artifacts_expiry on artifacts (expires_at)",
  `create table if not exists artifact_uploads (
    execution_id text not null,
    epoch integer not null,
    name text not null,
    size integer not null,
    sha256 text not null,
    content_type text not null,
    upload_id text,
    browse integer not null default 0,
    primary key (execution_id, epoch, name)
  )`,
] as const;

export class ArtifactDb extends Context.Service<ArtifactDb, D1Database>()(
  "@fractalboxdev/flare-dispatch-cache/ArtifactDb",
) {}

export class InvalidArtifactName extends Schema.TaggedError<InvalidArtifactName>()(
  "InvalidArtifactName",
  { name: Schema.String },
) {}

export class ArtifactTooLarge extends Schema.TaggedError<ArtifactTooLarge>()("ArtifactTooLarge", {
  reason: Schema.String,
}) {}

export class ArtifactRefused extends Schema.TaggedError<ArtifactRefused>()("ArtifactRefused", {
  status: Schema.Number,
  reason: Schema.String,
}) {}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** FD-CACHE-070: the name grammar, with no `..` segment. */
export const validArtifactName = (name: string) =>
  NAME.test(name) && !name.split("/").some((s) => s === ".." || s === "." || s === "");

/** FD-CACHE-069: 128 random bits from the platform's cryptographically secure generator. */
export const newArtifactId = random128;

export const artifactPath = (executionId: string, epoch: number, name: string) =>
  `artifacts/${executionId}/${epoch}/${name}`;

/** Browse-expansion bounds (FD-CACHE-073). */
export const BROWSE_BOUNDS = { maxEntryBytes: 32 * MiB, maxTotalBytes: 256 * MiB, maxEntries: 4000 };

export const checkBrowseExpansion = (
  entries: readonly { readonly path: string; readonly size: number }[],
): Effect.Effect<void, ArtifactTooLarge | InvalidArtifactName> =>
  Effect.gen(function* () {
    if (entries.length > BROWSE_BOUNDS.maxEntries)
      return yield* Effect.fail(new ArtifactTooLarge({ reason: `${entries.length} entries` }));
    let total = 0;
    for (const e of entries) {
      if (!validArtifactName(e.path)) return yield* Effect.fail(new InvalidArtifactName({ name: e.path }));
      if (e.size > BROWSE_BOUNDS.maxEntryBytes)
        return yield* Effect.fail(new ArtifactTooLarge({ reason: `entry ${e.path} is ${e.size} bytes` }));
      total += e.size;
    }
    if (total > BROWSE_BOUNDS.maxTotalBytes)
      return yield* Effect.fail(new ArtifactTooLarge({ reason: `expansion totals ${total} bytes` }));
  });

/** The parts of a multipart upload: one size of at least `minPartBytes` for every part but the last. */
export const multipartPlan = (size: number, minPartBytes: number) => {
  const partSize = Math.max(minPartBytes, Math.ceil(size / 10_000));
  const count = Math.ceil(size / partSize);
  return Array.from({ length: count }, (_, i) => ({
    partNumber: i + 1,
    length: i === count - 1 ? size - partSize * (count - 1) : partSize,
  }));
};

export interface BeginArtifact {
  readonly execution_id: string;
  readonly epoch: number;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly content_type: string;
  readonly browse?: readonly { readonly path: string; readonly size: number }[];
}

export type BeginAnswer =
  | { readonly status: "stale" }
  | {
      readonly status: "ok";
      readonly upload_id: string | null;
      readonly urls: readonly {
        readonly part_number: number | null;
        readonly path: string | null;
        readonly url: string;
        readonly length: number;
        readonly expires_at: number;
      }[];
    };

const sum = (rows: readonly { readonly bytes: number | null }[]) => Number(rows[0]?.bytes ?? 0);

/**
 * Starts one artifact upload. The name must match the grammar (FD-CACHE-070), the execution's artifacts must stay
 * within the per-execution bound, default 2 GiB (FD-CACHE-074), and a browse expansion within its bounds
 * (FD-CACHE-073). A body of at most 16 MiB gets one `PUT` URL; a larger one a multipart upload the control plane
 * creates with `createMultipartUpload`, presigned as one UploadPart URL per part (FD-CACHE-072).
 */
export const beginArtifactUpload = (frame: BeginArtifact, bounds: ByteBounds = DEFAULT_BYTE_BOUNDS) =>
  Effect.gen(function* () {
    const lease = yield* (yield* CacheLeases).current(frame.execution_id);
    const db = yield* ArtifactDb;
    const bucket = yield* CacheBucket;
    const signer = yield* R2Presigner;
    const now = (yield* CacheClock).now();
    if (lease === null || lease.epoch !== frame.epoch) return { status: "stale" } as BeginAnswer;
    if (lease.status === "terminal")
      return yield* Effect.fail(new ArtifactRefused({ status: 403, reason: "execution is terminal" }));
    if (lease.confidential === true)
      return yield* Effect.fail(
        new ArtifactRefused({ status: 403, reason: "confidential-compute keeps artifacts on the device" }),
      );
    if (!validArtifactName(frame.name))
      return yield* Effect.fail(new InvalidArtifactName({ name: frame.name }));
    if (!Number.isSafeInteger(frame.size) || frame.size < 0 || !/^[0-9a-f]{64}$/.test(frame.sha256))
      return yield* Effect.fail(new ArtifactRefused({ status: 400, reason: "size or sha256 malformed" }));
    const browse = frame.browse ?? [];
    yield* checkBrowseExpansion(browse);
    const browseBytes = browse.reduce((s, e) => s + e.size, 0);
    const committed = yield* Effect.promise(() =>
      db
        .prepare("select sum(size) as bytes from artifacts where execution_id = ?")
        .bind(frame.execution_id)
        .all<{ bytes: number | null }>(),
    );
    const pending = yield* Effect.promise(() =>
      db
        .prepare("select sum(size) as bytes from artifact_uploads where execution_id = ? and name != ?")
        .bind(frame.execution_id, frame.name)
        .all<{ bytes: number | null }>(),
    );
    const total = sum(committed.results) + sum(pending.results) + frame.size + browseBytes;
    if (total > bounds.maxExecutionArtifactBytes)
      return yield* Effect.fail(
        new ArtifactTooLarge({
          reason: `execution artifacts would total ${total} bytes of ${bounds.maxExecutionArtifactBytes}`,
        }),
      );
    const path = artifactPath(frame.execution_id, frame.epoch, frame.name);
    const expiresAt = Math.min(now + MAX_URL_LIFETIME_MS, lease.deadlineAt);
    const urls: Extract<BeginAnswer, { status: "ok" }>["urls"][number][] = [];
    let uploadId: string | null = null;
    if (frame.size <= bounds.singlePutMaxBytes) {
      const signed = yield* signer.presign({ key: path, method: "PUT", length: frame.size, expiresAt });
      urls.push({ part_number: null, path: null, url: signed.url, length: frame.size, expires_at: signed.expiresAt });
    } else {
      const upload = yield* Effect.promise(() =>
        bucket.createMultipartUpload(path, { httpMetadata: { contentType: frame.content_type } }),
      );
      uploadId = upload.uploadId;
      for (const part of multipartPlan(frame.size, bounds.minPartBytes)) {
        const signed = yield* signer.presign({
          key: path,
          method: "PUT",
          length: part.length,
          expiresAt,
          query: { partNumber: String(part.partNumber), uploadId: upload.uploadId },
        });
        urls.push({
          part_number: part.partNumber,
          path: null,
          url: signed.url,
          length: part.length,
          expires_at: signed.expiresAt,
        });
      }
    }
    for (const entry of browse) {
      const signed = yield* signer.presign({
        key: `${path}.browse/${entry.path}`,
        method: "PUT",
        length: entry.size,
        expiresAt,
      });
      urls.push({ part_number: null, path: entry.path, url: signed.url, length: entry.size, expires_at: signed.expiresAt });
    }
    yield* Effect.promise(() =>
      db
        .prepare(
          `insert into artifact_uploads (execution_id, epoch, name, size, sha256, content_type, upload_id, browse)
           values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           on conflict (execution_id, epoch, name) do update set size = excluded.size, sha256 = excluded.sha256,
             content_type = excluded.content_type, upload_id = excluded.upload_id, browse = excluded.browse`,
        )
        .bind(frame.execution_id, frame.epoch, frame.name, frame.size + browseBytes, frame.sha256,
          frame.content_type, uploadId, browse.length > 0 ? 1 : 0)
        .run(),
    );
    return { status: "ok", upload_id: uploadId, urls } as BeginAnswer;
  });

export const DEFAULT_ARTIFACT_RETENTION_MS = 30 * 24 * 3600 * 1000;

export interface CommitArtifact {
  readonly execution_id: string;
  readonly epoch: number;
  readonly name: string;
  readonly parts?: readonly { readonly part_number: number; readonly etag: string }[];
}

export type ArtifactAck =
  | { readonly status: "stale" }
  | { readonly status: "duplicate" | "accepted"; readonly artifact_id: string };

/**
 * Commits an artifact from `exec.artifact.commit`. A frame whose epoch is not the current epoch is `stale`
 * (FD-CACHE-071). A multipart upload completes with `resumeMultipartUpload(...).complete()` and the part ETags
 * (FD-CACHE-072); the stored size must equal the declared one. The control plane then records one row
 * (FD-CACHE-068) with a fresh `artifact_id` (FD-CACHE-069) and `expires_at` at the retention after creation, default
 * 30 days, or the longer retention a provenance statement asks for (FD-CACHE-079).
 */
export const commitArtifact = (
  frame: CommitArtifact,
  repository: { readonly repo: string; readonly private: boolean },
  retention: { readonly retentionMs?: number; readonly extendedMs?: number } = {},
) =>
  Effect.gen(function* () {
    const lease = yield* (yield* CacheLeases).current(frame.execution_id);
    const db = yield* ArtifactDb;
    const bucket = yield* CacheBucket;
    const now = (yield* CacheClock).now();
    if (lease === null || lease.epoch !== frame.epoch) return { status: "stale" } as ArtifactAck;
    const existing = yield* Effect.promise(() =>
      db
        .prepare("select artifact_id from artifacts where execution_id = ? and epoch = ? and name = ?")
        .bind(frame.execution_id, frame.epoch, frame.name)
        .first<{ artifact_id: string }>(),
    );
    if (existing !== null) return { status: "duplicate", artifact_id: existing.artifact_id } as ArtifactAck;
    const upload = yield* Effect.promise(() =>
      db
        .prepare("select * from artifact_uploads where execution_id = ? and epoch = ? and name = ?")
        .bind(frame.execution_id, frame.epoch, frame.name)
        .first<{ size: number; sha256: string; content_type: string; upload_id: string | null; browse: number }>(),
    );
    if (upload === null)
      return yield* Effect.fail(new ArtifactRefused({ status: 409, reason: "no upload was started" }));
    const path = artifactPath(frame.execution_id, frame.epoch, frame.name);
    if (upload.upload_id !== null) {
      const parts = (frame.parts ?? []).map((p) => ({ partNumber: p.part_number, etag: p.etag }));
      yield* Effect.tryPromise(() =>
        bucket.resumeMultipartUpload(path, upload.upload_id!).complete(parts),
      ).pipe(
        Effect.mapError(() => new ArtifactRefused({ status: 409, reason: "multipart completion failed" })),
      );
    }
    const stored = yield* Effect.promise(() => bucket.head(path));
    if (stored === null)
      return yield* Effect.fail(new ArtifactRefused({ status: 409, reason: "artifact body is not uploaded" }));
    const artifactId = newArtifactId();
    const keep = Math.max(retention.retentionMs ?? DEFAULT_ARTIFACT_RETENTION_MS, retention.extendedMs ?? 0);
    yield* Effect.promise(() =>
      db.batch([
        db
          .prepare(
            `insert into artifacts (artifact_id, execution_id, epoch, name, size, sha256, content_type,
               producer_executor_id, producer_executor_kind, repo, private, r2_path, browse, created_at, expires_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
          )
          .bind(artifactId, frame.execution_id, frame.epoch, frame.name, stored.size, upload.sha256,
            upload.content_type, lease.executorId, lease.executorKind, repository.repo.toLowerCase(),
            repository.private ? 1 : 0, path, upload.browse, now, now + keep),
        db
          .prepare("delete from artifact_uploads where execution_id = ? and epoch = ? and name = ?")
          .bind(frame.execution_id, frame.epoch, frame.name),
      ]),
    );
    return { status: "accepted", artifact_id: artifactId } as ArtifactAck;
  });

/**
 * Records an artifact a `confidential-compute` execution keeps on its device (FD-CACHE-080): the row names the
 * producing executor and holds no R2 path.
 */
export const recordDeviceArtifact = (
  frame: { readonly execution_id: string; readonly epoch: number; readonly name: string; readonly size: number;
    readonly sha256: string; readonly content_type: string },
  producer: { readonly executorId: string; readonly executorKind: ExecutorKind },
  repository: { readonly repo: string; readonly private: boolean },
) =>
  Effect.gen(function* () {
    const db = yield* ArtifactDb;
    const now = (yield* CacheClock).now();
    if (!validArtifactName(frame.name)) return yield* Effect.fail(new InvalidArtifactName({ name: frame.name }));
    const artifactId = newArtifactId();
    yield* Effect.promise(() =>
      db
        .prepare(
          `insert into artifacts (artifact_id, execution_id, epoch, name, size, sha256, content_type,
             producer_executor_id, producer_executor_kind, repo, private, r2_path, browse, created_at, expires_at)
           values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, null, 0, ?12, ?13)`,
        )
        .bind(artifactId, frame.execution_id, frame.epoch, frame.name, frame.size, frame.sha256,
          frame.content_type, producer.executorId, producer.executorKind, repository.repo.toLowerCase(),
          repository.private ? 1 : 0, now, now + DEFAULT_ARTIFACT_RETENTION_MS)
        .run(),
    );
    return artifactId;
  });

// ---- Serving -----------------------------------------------------------------------

export const ARTIFACT_TOKEN_LABEL = "flare-dispatch/artifact/v1";

/** An artifact capability token: bound to one `artifact_id`, at most 7 days (FD-CACHE-077). */
export const signArtifactToken = (secret: string, artifactId: string, expiresAt: number, nowMs: number) =>
  signCapability(secret, ARTIFACT_TOKEN_LABEL, artifactId, expiresAt, nowMs);

interface ArtifactRow {
  readonly artifact_id: string;
  readonly execution_id: string;
  readonly epoch: number;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly content_type: string;
  readonly producer_executor_id: string;
  readonly producer_executor_kind: string;
  readonly repo: string;
  readonly private: number;
  readonly r2_path: string | null;
  readonly browse: number;
  readonly created_at: number;
  readonly expires_at: number;
}

export interface ArtifactRouteDeps {
  readonly db: D1Database;
  readonly bucket: Pick<R2Bucket, "get">;
  readonly secret: string;
  readonly now: () => number;
  readonly terminal: (executionId: string) => Promise<boolean>;
  /** A viewer identity with read access to `repo`, when the request carries one. */
  readonly viewerMayRead?: (request: Request, repo: string) => Promise<boolean>;
}

const notFound = () => new Response("not found", { status: 404 });
const ARTIFACT_ROUTE = /^\/v1\/artifacts\/([0-9a-f]{32})(?:\/(.+))?$/;
const LIST_ROUTE = /^\/v1\/executions\/([A-Za-z0-9:_-]{3,128})\/artifacts$/;
export const ARTIFACT_PAGE_SIZE = 100;

const tokenOf = (request: Request, url: URL) => {
  const auth = request.headers.get("authorization");
  return (auth === null ? null : /^Bearer\s+(\S+)$/i.exec(auth.trim())?.[1]) ?? url.searchParams.get("token");
};

/**
 * `GET /v1/artifacts/<artifact_id>[/<browse path>]` and `GET /v1/executions/<id>/artifacts`. A private repository's
 * artifact needs a viewer with read access or an unexpired capability token bound to the `artifact_id`; otherwise
 * `404` (FD-CACHE-076). Once the producing execution is terminal the body is served `Cache-Control: immutable`
 * (FD-CACHE-075). The listing pages at most 100 rows with a cursor and lists artifact rows only, never the files of
 * a browse expansion (FD-CACHE-078).
 */
export const handleArtifacts = async (request: Request, deps: ArtifactRouteDeps): Promise<Response | null> => {
  const url = new URL(request.url);
  const list = LIST_ROUTE.exec(url.pathname);
  if (list !== null) return listArtifacts(request, url, list[1]!, deps);
  const m = ARTIFACT_ROUTE.exec(url.pathname);
  if (m === null) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
  const row = await deps.db.prepare("select * from artifacts where artifact_id = ?").bind(m[1]).first<ArtifactRow>();
  if (row === null || row.expires_at <= deps.now()) return notFound();
  if (row.private === 1) {
    const token = await verifyCapability(deps.secret, ARTIFACT_TOKEN_LABEL, row.artifact_id, tokenOf(request, url), deps.now());
    const viewer = !token && deps.viewerMayRead !== undefined && (await deps.viewerMayRead(request, row.repo));
    if (!token && !viewer) return notFound();
  }
  if (row.r2_path === null)
    return Response.json(
      { artifact_id: row.artifact_id, kept_on_executor: row.producer_executor_id },
      { status: 409 },
    );
  const browsePath = m[2];
  if (browsePath !== undefined && (row.browse !== 1 || !validArtifactName(browsePath))) return notFound();
  const object = await deps.bucket.get(browsePath === undefined ? row.r2_path : `${row.r2_path}.browse/${browsePath}`);
  if (object === null) return notFound();
  const terminal = await deps.terminal(row.execution_id);
  return new Response(request.method === "HEAD" ? null : object.body, {
    headers: {
      "content-type": browsePath === undefined ? row.content_type : (object.httpMetadata?.contentType ?? "application/octet-stream"),
      "content-length": String(object.size),
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "cache-control": terminal ? "public, max-age=31536000, immutable" : "no-store",
      ...(browsePath === undefined ? { etag: `"${row.sha256}"` } : {}),
    },
  });
};

const listArtifacts = async (request: Request, url: URL, executionId: string, deps: ArtifactRouteDeps) => {
  const limit = Math.min(ARTIFACT_PAGE_SIZE, Math.max(1, Number(url.searchParams.get("limit") ?? ARTIFACT_PAGE_SIZE) || ARTIFACT_PAGE_SIZE));
  const cursor = url.searchParams.get("cursor") ?? "";
  const { results } = await deps.db
    .prepare(
      `select artifact_id, name, size, sha256, content_type, epoch, producer_executor_id, producer_executor_kind,
         repo, private, expires_at from artifacts where execution_id = ? and artifact_id > ? and expires_at > ?
       order by artifact_id limit ?`,
    )
    .bind(executionId, cursor, deps.now(), limit + 1)
    .all<ArtifactRow>();
  const visible = [];
  for (const row of results.slice(0, limit)) {
    if (row.private === 1 && !(deps.viewerMayRead !== undefined && (await deps.viewerMayRead(request, row.repo))))
      continue;
    visible.push({
      artifact_id: row.artifact_id,
      name: row.name,
      size: row.size,
      sha256: row.sha256,
      content_type: row.content_type,
      epoch: row.epoch,
      producer: { executor_id: row.producer_executor_id, executor_kind: row.producer_executor_kind },
      expires_at: row.expires_at,
    });
  }
  const next = results.length > limit ? results[limit - 1]!.artifact_id : null;
  return Response.json({ artifacts: visible, cursor: next });
};

/**
 * One tick of the artifact sweep (FD-CACHE-079): deletes every artifact whose `expires_at` passed, its body, its
 * browse expansion and its row, in batches of 100 rows.
 */
export const sweepArtifacts = async (
  db: D1Database,
  bucket: Pick<R2Bucket, "delete" | "list">,
  nowMs: number,
  maxBatches = 50,
) => {
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const { results } = await db
      .prepare("select artifact_id, r2_path, browse from artifacts where expires_at <= ? limit 100")
      .bind(nowMs)
      .all<{ artifact_id: string; r2_path: string | null; browse: number }>();
    if (results.length === 0) break;
    for (const row of results) {
      if (row.r2_path === null) continue;
      const keys = [row.r2_path];
      if (row.browse === 1) {
        let cursor: string | undefined;
        do {
          const page = await bucket.list({ prefix: `${row.r2_path}.browse/`, limit: 1000, ...(cursor ? { cursor } : {}) });
          keys.push(...page.objects.map((o) => o.key));
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor !== undefined);
      }
      for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
    }
    await db.batch(
      results.map((r) => db.prepare("delete from artifacts where artifact_id = ?").bind(r.artifact_id)),
    );
    deleted += results.length;
  }
  return { deleted };
};
