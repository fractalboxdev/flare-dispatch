// @fractalboxdev/flare-dispatch-github-app — read one text file out of a repo.
//
// `readRepoTextFile` reads a single path:
//   GET /repos/{owner}/{repo}/contents/{path}?ref={ref}   Accept: …github.raw
//
// The raw media type returns the file's bytes directly, so there is no base64
// round-trip and no 1 MB inline-content ceiling to trip over.
//
// Deliberately ONE narrow read, not a filesystem. The maintenance loop's
// suppression ledger (`infra/maintenance-loop/declined.jsonl`) lives in git in a
// private repo, and cloning a repo to read one line on every cron tick is
// absurd. Anything wider — trees, directories, writes — has a home already
// (`commitFilesAndOpenPr` writes; a run that needs a working tree clones).
//
// **Absent is a value, not an error.** A 404 returns `{ found: false }`, which
// is what a ledger that does not exist yet looks like — a caller must be able to
// tell that apart from "GitHub said 500", because the two demand opposite
// behavior (proceed vs. warn). Every other non-2xx still throws
// `GithubApiError`.
//
// Authenticated with an installation access token (installation-token.ts) —
// never an App JWT, never a PAT; the ledger repo is private. Provider-neutral
// plain `async`; the Effect Layer (`makeGithubLive`) wraps it.

import { assertOk, API_BASE_DEFAULT, ghHeaders, resolveClient, splitRepo } from "./http";

export type ReadRepoTextFileOptions = {
  /** The installation access token authenticating the call. */
  readonly token: string;
  /** `"owner/repo"`. */
  readonly repo: string;
  /** Repo-relative path (e.g. `infra/maintenance-loop/declined.jsonl`). */
  readonly path: string;
  /** Branch, tag, or sha. Defaults to the repo's default branch. */
  readonly ref?: string;
  /** API base override (tests / GHE). */
  readonly apiBase?: string;
  /** `fetch` override — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

/** A file's contents, or the clean "there is no such file" answer. */
export type ReadRepoTextFileResult =
  | { readonly found: true; readonly content: string }
  | { readonly found: false };

/** Build the `contents` request URL — pure, for unit testing. */
export const repoContentsUrl = (opts: {
  readonly repo: string;
  readonly path: string;
  readonly ref?: string;
  readonly apiBase?: string;
}): string => {
  const { owner, name } = splitRepo(opts.repo);
  const base = opts.apiBase ?? API_BASE_DEFAULT;
  // Encode each segment, not the whole path — the slashes are structural.
  const path = opts.path
    .split("/")
    .filter((s) => s.length > 0)
    .map(encodeURIComponent)
    .join("/");
  const query = opts.ref !== undefined ? `?ref=${encodeURIComponent(opts.ref)}` : "";
  return `${base}/repos/${owner}/${name}/contents/${path}${query}`;
};

/**
 * Read one text file. `{ found: false }` when the path does not exist at `ref`
 * — and when it exists but is not a file (a directory answers the raw media
 * type with a JSON listing, which is not a text file the caller asked for).
 *
 * @throws {GithubApiError} on any non-2xx other than 404.
 */
export const readRepoTextFile = async (
  opts: ReadRepoTextFileOptions,
): Promise<ReadRepoTextFileResult> => {
  const { doFetch } = resolveClient(opts);
  const res = await doFetch(repoContentsUrl(opts), {
    method: "GET",
    headers: { ...ghHeaders(opts.token), Accept: "application/vnd.github.raw" },
  });
  if (res.status === 404) return { found: false };
  await assertOk(res, `contents read failed for ${opts.repo}:${opts.path}`);
  // A directory (or a submodule/symlink) still answers 200, as JSON. Not a text
  // file → the same answer as absent, rather than a second error taxonomy.
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    return { found: false };
  }
  return { found: true, content: await res.text() };
};
