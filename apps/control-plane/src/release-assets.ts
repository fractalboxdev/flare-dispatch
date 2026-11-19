// `ReleaseAssets` for `image-publish` (FD-GATE-129, FD-GATE-130): the control plane downloads a private release asset
// under an installation token scoped to the asset's repository with `contents: read`, streams it into the object store
// at `cas/<sha256>` while it hashes the bytes, and hands the build a presigned GET URL and the digest. The build holds
// no GitHub token. An object already stored at the key is not downloaded again.
import {
  AssetFailed,
  type ReleaseAsset,
  type StagedAsset,
} from "@fractalboxdev/flare-dispatch-catalog";
import type { R2PresignerService } from "@fractalboxdev/flare-dispatch-cache";
import { MAX_URL_LIFETIME_MS } from "@fractalboxdev/flare-dispatch-cache";
import { Effect, Schema } from "effect";

/** The largest asset the control plane stages (FD-GATE-130). */
export const MAX_ASSET_BYTES = 512 * 1024 * 1024;

/** The object store the assets are written to: the `CACHE` bucket, by key. */
export interface AssetStore {
  readonly exists: (key: string) => Promise<boolean>;
  /** Writes `size` bytes from `body` at `key`. */
  readonly put: (key: string, body: ReadableStream<Uint8Array>, size: number) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
}

/** The R2 binding's methods the store reads. */
export interface AssetBucket {
  head(key: string): Promise<unknown>;
  put(key: string, value: ReadableStream<Uint8Array>): Promise<unknown>;
  delete(key: string): Promise<void>;
}

interface WorkersStreams {
  readonly FixedLengthStream?: new (length: number) => {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
  };
}

/** The store over an R2 bucket; a stream R2 cannot size is wrapped in a `FixedLengthStream` of the asset's size. */
export const r2AssetStore = (bucket: AssetBucket): AssetStore => ({
  exists: async (key) => (await bucket.head(key)) !== null,
  put: async (key, body, size) => {
    const Fixed = (globalThis as WorkersStreams).FixedLengthStream;
    if (Fixed === undefined) {
      await bucket.put(key, body);
      return;
    }
    const sized = new Fixed(size);
    const piped = body.pipeTo(sized.writable);
    await Promise.all([bucket.put(key, sized.readable), piped]);
  },
  remove: (key) => bucket.delete(key),
});

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

interface DigestStreamCtor {
  new (algorithm: string): WritableStream<Uint8Array> & { readonly digest: Promise<ArrayBuffer> };
}

/** The SHA-256 of a stream: `crypto.DigestStream` in the Worker, which never holds the bytes; a buffer elsewhere. */
export const sha256OfStream = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const Digest = (crypto as unknown as { DigestStream?: DigestStreamCtor }).DigestStream;
  if (Digest !== undefined) {
    const sink = new Digest("SHA-256");
    await stream.pipeTo(sink);
    return hex(await sink.digest);
  }
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return hex(await crypto.subtle.digest("SHA-256", bytes));
};

const Release = Schema.Struct({
  assets: Schema.Array(
    Schema.Struct({ id: Schema.Number, name: Schema.String, size: Schema.Number }),
  ),
});

export interface ReleaseAssetsDeps {
  /** An installation token for `repo` scoped to it with `contents: read`, or `null` where no installation serves it. */
  readonly tokenFor: (repo: string) => Effect.Effect<string | null, AssetFailed>;
  readonly fetch: typeof globalThis.fetch;
  readonly apiBase: string;
  readonly store: AssetStore | undefined;
  readonly presigner: R2PresignerService | undefined;
  readonly deadlineAt: number | undefined;
  readonly now: () => number;
}

/** Stages one asset, or fails with the kind FD-GATE-130 names. */
export const stageReleaseAsset = (deps: ReleaseAssetsDeps) => (asset: ReleaseAsset) =>
  Effect.gen(function* () {
    const fail = (kind: AssetFailed["kind"]) =>
      Effect.fail(new AssetFailed({ key: asset.key, kind }));
    const store = deps.store;
    const presigner = deps.presigner;
    if (store === undefined || presigner === undefined) return yield* fail("unavailable");
    const expected = asset.sha256;
    const key = `cas/${expected}`;
    const tryPromise = <A>(f: () => Promise<A>) =>
      Effect.tryPromise({
        try: f,
        catch: () => new AssetFailed({ key: asset.key, kind: "unavailable" }),
      });
    if (!(yield* tryPromise(() => store.exists(key)))) {
      const token = yield* deps.tokenFor(asset.repo);
      if (token === null) return yield* fail("uninstalled");
      const headers = {
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      };
      const release = yield* tryPromise(() =>
        deps.fetch(
          `${deps.apiBase}/repos/${asset.repo}/releases/tags/${encodeURIComponent(asset.tag)}`,
          { headers: { ...headers, accept: "application/vnd.github+json" } },
        ),
      );
      if (release.status === 404) return yield* fail("not found");
      if (!release.ok) return yield* fail("unavailable");
      const body = yield* tryPromise(() => release.json() as Promise<unknown>);
      const decoded = Schema.decodeUnknownOption(Release)(body);
      if (decoded._tag === "None") return yield* fail("unavailable");
      const found = decoded.value.assets.find((a) => a.name === asset.name);
      if (found === undefined) return yield* fail("not found");
      if (found.size > MAX_ASSET_BYTES) return yield* fail("too large");
      // The asset endpoint redirects to a presigned download; the redirect is followed without the token.
      const pointer = yield* tryPromise(() =>
        deps.fetch(`${deps.apiBase}/repos/${asset.repo}/releases/assets/${found.id}`, {
          headers: { ...headers, accept: "application/octet-stream" },
          redirect: "manual",
        }),
      );
      const location = pointer.headers.get("location");
      const download =
        pointer.status >= 300 && pointer.status < 400 && location !== null
          ? yield* tryPromise(() => deps.fetch(location))
          : pointer;
      if (!download.ok || download.body === null) return yield* fail("unavailable");
      const [toDigest, toStore] = download.body.tee();
      const [digest] = yield* tryPromise(() =>
        Promise.all([sha256OfStream(toDigest), store.put(key, toStore, found.size)]),
      );
      if (digest !== expected) {
        yield* tryPromise(() => store.remove(key));
        return yield* fail("digest mismatch");
      }
    }
    const now = deps.now();
    const expiresAt = Math.min(now + MAX_URL_LIFETIME_MS, deps.deadlineAt ?? Infinity);
    const signed = yield* presigner.presign({ key, method: "GET", length: null, expiresAt });
    return { url: signed.url, sha256: expected } satisfies StagedAsset;
  });
