// @fractalbox/flare-dispatch-github-app — create a GitHub Release.
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
// Layer (`makeGithubLive` in @fractalbox/flare-dispatch-runtime-cf) wraps it.

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

/**
 * Create (publish) a GitHub Release, creating the tag at `target` if needed.
 *
 * @throws {GithubApiError} when the API returns non-2xx — including a 422 when a
 * release already exists for `tag` (the caller's idempotency key should prevent
 * re-firing the same release, so a 422 here is a genuine conflict to surface).
 */
export const createRelease = async (
  opts: CreateReleaseOptions,
): Promise<CreateReleaseResult> => {
  const { owner, name: repoName } = splitRepo(opts.repo);
  const { apiBase, doFetch } = resolveClient(opts);

  const res = await doFetch(
    `${apiBase}/repos/${owner}/${repoName}/releases`,
    {
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
    },
  );

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
