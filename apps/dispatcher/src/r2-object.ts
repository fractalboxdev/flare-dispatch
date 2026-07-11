// FlareDispatch Dispatcher — shared R2-object streaming helpers.
//
// Extracted from routes/artifacts.ts so the artifact route AND the log routes
// (routes/logs.ts) stream stored objects through one definition rather than two
// drifting copies (review: "extract the streamObject helper instead of
// copying"). The R2 `get` returns the body as a `ReadableStream`, so large
// objects (a tens-of-MB exec log, a report bundle) are streamed, never buffered.

/** R2 key for a per-execution artifact — matches `R2ArtifactLive.upload`. */
export const artifactKey = (execution: string, name: string): string =>
  `artifacts/${execution}/${name}`;

/** R2 key for a per-execution exec log — matches `SandboxCloudflareLive`. */
export const logKey = (execution: string, file: string): string =>
  `logs/${execution}/${file}`;

/** A JSON `{ error, message }` response. */
export const jsonError = (
  error: string,
  message: string,
  status: number,
): Response =>
  new Response(JSON.stringify({ error, message }), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Per-response overrides layered on top of the stored object's own metadata. */
export type StreamOptions = {
  /** Override `content-type` (else the stored object's, else octet-stream). */
  readonly contentType?: string;
  /** `cache-control` value — omitted when undefined. */
  readonly cacheControl?: string;
  /** Add `X-Content-Type-Options: nosniff` (log/text routes set this). */
  readonly nosniff?: boolean;
};

/**
 * Stream one stored R2 object with its metadata, or `null` if absent. The
 * stored object's `httpMetadata`/etag are written through; `opts` layers
 * content-type / cache-control / nosniff on top.
 */
export const streamObject = async (
  bucket: R2Bucket,
  key: string,
  opts: StreamOptions = {},
): Promise<Response | null> => {
  const object = await bucket.get(key);
  if (object === null) return null;

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set(
    "content-type",
    opts.contentType ??
      object.httpMetadata?.contentType ??
      "application/octet-stream",
  );
  headers.set("etag", object.httpEtag);
  if (opts.cacheControl !== undefined) {
    headers.set("cache-control", opts.cacheControl);
  }
  if (opts.nosniff === true) {
    headers.set("x-content-type-options", "nosniff");
  }
  return new Response(object.body, { status: 200, headers });
};
