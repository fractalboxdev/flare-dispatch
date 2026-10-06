// @fractalboxdev/flare-dispatch-github-app — create a GitHub Release.
//
// `createRelease` publishes a release:
//   POST /repos/{owner}/{repo}/releases  { tag_name, target_commitish, name, body, ... }
//
// When `tag_name` does not yet exist GitHub creates the tag at `target_commitish`
// (a branch name OR a commit sha) as part of publishing the release — so the
// caller needs no separate `POST /git/refs` tag-create. The `release-notes` run
// pins `target_commitish` to the exact HEAD sha the notes were drafted from, so
// the tag is reproducible regardless of later pushes to the branch.
//
// Authenticated with an installation access token (installation-token.ts) —
// never an App JWT, never a PAT. Provider-neutral plain `async`; the Effect
// Layer (`makeGithubLive` in @fractalboxdev/flare-dispatch-runtime-cf) wraps it.

import { assertOk, ghHeaders, resolveClient, splitRepo } from "./http";

export type CreateReleaseOptions = {
  /** The installation access token authenticating the call. */
  readonly token: string;
  /** `"owner/repo"`. */
  readonly repo: string;
  /** The git tag to create/point the release at (e.g. `v0.1.0`). */
  readonly tag: string;
  /**
   * The commit sha (or branch) the tag is created at when it does not already
   * exist. Omit to let GitHub use the repo's default branch tip.
   */
  readonly target?: string;
  /** The release title — defaults to `tag` when omitted. */
  readonly name?: string;
  /** The release body (markdown). */
  readonly body: string;
  /** Publish as a draft (unlisted, no tag created). Default `false`. */
  readonly draft?: boolean;
  /** Mark as a pre-release. Default `false`. */
  readonly prerelease?: boolean;
  /** API base override (tests / GHE). */
  readonly apiBase?: string;
  /** `fetch` override — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

export type CreateReleaseResult = {
  /** The release's numeric id. */
  readonly id: number;
  /** The release's web URL. */
  readonly htmlUrl: string;
  /** The tag the release points at (echoed back by GitHub). */
  readonly tagName: string;
};

export type UploadReleaseAssetOptions = {
  readonly token: string;
  readonly repo: string;
  readonly releaseId: number;
  readonly name: string;
  readonly contentType: string;
  readonly content: ReadableStream<Uint8Array> | Uint8Array;
  readonly size: number;
  /** API host override for GitHub Enterprise and tests. */
  readonly uploadBase?: string;
  readonly fetchImpl?: typeof fetch;
};

export type UploadReleaseAssetResult = {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly downloadUrl: string;
};

/** Upload one R2-backed artifact without materializing it in Worker memory. */
export const uploadReleaseAsset = async (
  opts: UploadReleaseAssetOptions,
): Promise<UploadReleaseAssetResult> => {
  const { owner, name: repoName } = splitRepo(opts.repo);
  if (!Number.isSafeInteger(opts.releaseId) || opts.releaseId <= 0) {
    throw new TypeError("releaseId must be a positive integer");
  }
  if (!Number.isSafeInteger(opts.size) || opts.size < 0) {
    throw new TypeError("asset size must be a nonnegative integer");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(opts.name)) {
    throw new TypeError("asset name must be one path-free filename of at most 255 characters");
  }
  const uploadBase = opts.uploadBase ?? "https://uploads.github.com";
  const doFetch = opts.fetchImpl ?? fetch;
  const url = new URL(`${uploadBase}/repos/${owner}/${repoName}/releases/${opts.releaseId}/assets`);
  url.searchParams.set("name", opts.name);
  // Workers derives Content-Length only from a fixed-length body. The R2
  // ReadableStream stays streaming; the pump never buffers the whole asset.
  const FixedLength = (
    globalThis as typeof globalThis & {
      FixedLengthStream?: new (size: number) => {
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<Uint8Array>;
      };
    }
  ).FixedLengthStream;
  const fixed =
    opts.content instanceof ReadableStream && FixedLength !== undefined
      ? new FixedLength(opts.size)
      : undefined;
  const pump =
    fixed !== undefined && opts.content instanceof ReadableStream
      ? opts.content.pipeTo(fixed.writable)
      : undefined;
  const body = fixed?.readable ?? opts.content;
  const request = doFetch(url, {
    method: "POST",
    headers: {
      ...ghHeaders(opts.token),
      "Content-Type": opts.contentType,
      "Content-Length": String(opts.size),
    },
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
  const [res] = await Promise.all([request, pump ?? Promise.resolve()]);
  await assertOk(res, "release asset upload failed");
  const json = (await res.json()) as {
    id: number;
    name: string;
    size: number;
    browser_download_url: string;
  };
  return {
    id: json.id,
    name: json.name,
    size: json.size,
    downloadUrl: json.browser_download_url,
  };
};

/**
 * Create (publish) a GitHub Release, creating the tag at `target` if needed.
 *
 * @throws {GithubApiError} when the API returns non-2xx — including a 422 when a
 * release already exists for `tag` (the caller's idempotency key should prevent
 * re-firing the same release, so a 422 here is a genuine conflict to surface).
 */
export const createRelease = async (opts: CreateReleaseOptions): Promise<CreateReleaseResult> => {
  const { owner, name: repoName } = splitRepo(opts.repo);
  const { apiBase, doFetch } = resolveClient(opts);

  const res = await doFetch(`${apiBase}/repos/${owner}/${repoName}/releases`, {
    method: "POST",
    headers: ghHeaders(opts.token, { json: true }),
    body: JSON.stringify({
      tag_name: opts.tag,
      ...(opts.target !== undefined ? { target_commitish: opts.target } : {}),
      name: opts.name ?? opts.tag,
      body: opts.body,
      draft: opts.draft ?? false,
      prerelease: opts.prerelease ?? false,
      // We render our own categorized notes; never ask GitHub to overwrite
      // `body` with its auto-generated list.
      generate_release_notes: false,
    }),
  });

  await assertOk(res, "release create failed");

  const json = (await res.json().catch(() => ({}))) as {
    id?: number;
    html_url?: string;
    tag_name?: string;
  };
  return {
    id: json.id ?? 0,
    htmlUrl: json.html_url ?? "",
    tagName: json.tag_name ?? opts.tag,
  };
};
