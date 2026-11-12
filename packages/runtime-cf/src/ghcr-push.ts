type BlobBody = Uint8Array | ReadableStream<Uint8Array>;

const INDEX = "application/vnd.oci.image.index.v1+json";
const MANIFEST = "application/vnd.oci.image.manifest.v1+json";

/**
 * One platform of an image index, as `contextful-ci image` writes it: the
 * config and manifest blobs verbatim, the layer they name, and the manifest's
 * index entry. The push uploads each verbatim, so the index digest equals the
 * one the build computed.
 */
export type GhcrPlatformImage = {
  readonly layerDigest: string;
  readonly layerSize: number;
  /** Opened only when the registry lacks the layer. */
  readonly openLayer: () => Promise<BlobBody>;
  readonly configDigest: string;
  readonly config: Uint8Array;
  readonly manifestDigest: string;
  readonly manifest: Uint8Array;
  /** The manifest's descriptor in the index, with its `platform`. */
  readonly entry: Readonly<Record<string, unknown>>;
};

export type GhcrImageIndex = {
  readonly username: string;
  readonly token: string;
  /** Registry path without ghcr.io, e.g. owner/repo/profile. */
  readonly name: string;
  readonly tag: string;
  /** In index order. */
  readonly platforms: readonly GhcrPlatformImage[];
  readonly fetchImpl?: typeof fetch;
};

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const digest = async (bytes: Uint8Array): Promise<string> =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

const requireOk = async (response: Response, operation: string): Promise<void> => {
  if (!response.ok) throw new Error(`${operation} failed with HTTP ${response.status}`);
};

const fixedBody = (body: BlobBody, size: number): { body: BlobBody; pump?: Promise<void> } => {
  const FixedLength = (globalThis as typeof globalThis & {
    FixedLengthStream?: new (size: number) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
  }).FixedLengthStream;
  if (!(body instanceof ReadableStream) || FixedLength === undefined) return { body };
  const fixed = new FixedLength(size);
  return { body: fixed.readable, pump: body.pipeTo(fixed.writable) };
};

const SHA256 = /^sha256:[a-f0-9]{64}$/;

/**
 * Refuse a platform whose blobs differ from their digests, whose manifest
 * names other blobs, or whose entry describes another manifest.
 */
const verifyPlatform = async (platform: GhcrPlatformImage): Promise<void> => {
  const invalid = () => new TypeError("invalid OCI image name, tag, digest, or size");
  if (![platform.layerDigest, platform.configDigest, platform.manifestDigest].every((d) => SHA256.test(d)) ||
    !Number.isSafeInteger(platform.layerSize) || platform.layerSize < 0) throw invalid();
  if (`sha256:${await digest(platform.config)}` !== platform.configDigest ||
    `sha256:${await digest(platform.manifest)}` !== platform.manifestDigest) throw invalid();
  const manifest = JSON.parse(new TextDecoder().decode(platform.manifest)) as {
    mediaType?: unknown; config?: { digest?: unknown; size?: unknown };
    layers?: ReadonlyArray<{ digest?: unknown; size?: unknown }>;
  };
  if (manifest.mediaType !== MANIFEST || manifest.config?.digest !== platform.configDigest ||
    manifest.config.size !== platform.config.byteLength || manifest.layers?.length !== 1 ||
    manifest.layers[0]?.digest !== platform.layerDigest || manifest.layers[0].size !== platform.layerSize) throw invalid();
  const { entry } = platform;
  const os = (entry.platform as { os?: unknown } | undefined)?.os;
  if (entry.mediaType !== MANIFEST || entry.digest !== platform.manifestDigest ||
    entry.size !== platform.manifest.byteLength || os !== "linux") throw invalid();
};

/**
 * Push a multi-platform image through the OCI Distribution API: each
 * platform's blobs and manifest by digest, then one image index under `tag`.
 * The index is compact JSON with its keys in sorted order, the form
 * `contextful-ci image` writes, so its digest is the build's.
 */
export const pushGhcrImageIndex = async (opts: GhcrImageIndex): Promise<void> => {
  if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(opts.name) ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(opts.tag) || opts.platforms.length === 0) {
    throw new TypeError("invalid OCI image name, tag, digest, or size");
  }
  for (const platform of opts.platforms) await verifyPlatform(platform);
  const doFetch = opts.fetchImpl ?? fetch;
  const scope = `repository:${opts.name}:pull,push`;
  const tokenUrl = new URL("https://ghcr.io/token");
  tokenUrl.searchParams.set("service", "ghcr.io");
  tokenUrl.searchParams.set("scope", scope);
  const tokenResponse = await doFetch(tokenUrl, {
    headers: { Authorization: `Basic ${btoa(`${opts.username}:${opts.token}`)}` },
  });
  await requireOk(tokenResponse, "GHCR token request");
  const { token } = (await tokenResponse.json()) as { token: string };
  if (!token) throw new Error("GHCR returned no scoped registry token");
  const auth = { Authorization: `Bearer ${token}` };
  const base = `https://ghcr.io/v2/${opts.name}`;
  const index = new TextEncoder().encode(JSON.stringify({
    manifests: opts.platforms.map((platform) => platform.entry), mediaType: INDEX, schemaVersion: 2,
  }));
  const indexDigest = `sha256:${await digest(index)}`;
  const tagUrl = `${base}/manifests/${encodeURIComponent(opts.tag)}`;
  const existing = await doFetch(tagUrl, { method: "HEAD", headers: { ...auth, Accept: INDEX } });
  if (existing.ok) {
    if (existing.headers.get("docker-content-digest") === indexDigest) return;
    throw new Error("GHCR image tag already names a different manifest");
  }
  if (existing.status !== 404) throw new Error(`GHCR manifest lookup failed with HTTP ${existing.status}`);
  // A blob upload is `application/octet-stream` (OCI Distribution); GHCR answers 404 to
  // a blob PUT typed with an image media type. Media types belong to the manifest.
  const uploadBlob = async (ref: string, open: () => Promise<BlobBody>, size: number): Promise<void> => {
    const exists = await doFetch(`${base}/blobs/${ref}`, { method: "HEAD", headers: auth });
    if (exists.ok) return;
    if (exists.status !== 404) throw new Error(`GHCR blob lookup failed with HTTP ${exists.status}`);
    const started = await doFetch(`${base}/blobs/uploads/`, { method: "POST", headers: auth });
    await requireOk(started, "GHCR blob upload start");
    const location = started.headers.get("location");
    if (location === null) throw new Error("GHCR omitted upload location");
    const uploadUrl = new URL(location, "https://ghcr.io");
    if (uploadUrl.protocol !== "https:" || uploadUrl.username || uploadUrl.password) {
      throw new Error("GHCR upload location is not HTTPS");
    }
    uploadUrl.searchParams.set("digest", ref);
    const fixed = fixedBody(await open(), size);
    const request = doFetch(uploadUrl, {
      method: "PUT",
      headers: { ...(uploadUrl.hostname === "ghcr.io" ? auth : {}),
        "Content-Type": "application/octet-stream", "Content-Length": String(size) },
      body: fixed.body,
      ...(fixed.body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit);
    const [finished] = await Promise.all([request, fixed.pump ?? Promise.resolve()]);
    await requireOk(finished, "GHCR blob upload");
  };
  const putManifest = async (url: string, mediaType: string, body: Uint8Array): Promise<void> => {
    const published = await doFetch(url, { method: "PUT", headers: { ...auth, "Content-Type": mediaType }, body });
    await requireOk(published, "GHCR manifest publish");
  };

  for (const platform of opts.platforms) {
    await uploadBlob(platform.layerDigest, platform.openLayer, platform.layerSize);
    await uploadBlob(platform.configDigest, async () => platform.config, platform.config.byteLength);
    await putManifest(`${base}/manifests/${platform.manifestDigest}`, MANIFEST, platform.manifest);
  }
  await putManifest(tagUrl, INDEX, index);
};

/**
 * A `pushGhcrImageIndex` failure as a GitHub API outcome: the registry's HTTP status
 * from the failing operation's message, its retry class, and the message itself.
 * A network failure (no status) is transient; a refused input or a conflicting
 * tag is final.
 */
export const classifyGhcrFailure = (cause: unknown): {
  status: number; reason: "rate-limited" | "unauthorized" | "transient" | "other"; detail: string;
} => {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const status = Number(/\bHTTP (\d{3})\b/.exec(detail)?.[1] ?? 0);
  const final = /^invalid OCI image|already names a different manifest/.test(detail);
  const reason = status === 401 || status === 403 ? "unauthorized"
    : status === 429 ? "rate-limited"
      : (status === 0 && !final) || status >= 500 ? "transient"
        : "other";
  return { status, reason, detail };
};
