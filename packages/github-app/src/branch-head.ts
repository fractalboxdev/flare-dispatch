// @fractalboxdev/flare-dispatch-github-app — read a branch's current head SHA.
//
// `readBranchHead` reads one ref:
//   GET /repos/{owner}/{repo}/git/ref/heads/{branch}
//
// `worker-deploy` asks this at dequeue time, and exposes the answer to the
// deploy command, because the sandbox checkout cannot: its `origin` carries no
// credential after the clone (`scrubCloneCredential`), so `git ls-remote` fails
// on every private repo. The Worker holds the App credentials; the container
// never does.
//
// Every non-2xx throws `GithubApiError`, 404 included. A branch that does not
// exist has no head, and "no head" must not read as a SHA a caller could compare
// against — the caller maps any failure to "unknown".

import { assertOk, ghHeaders, resolveClient, splitRepo } from "./http";
import { GithubApiError } from "./errors";

export type ReadBranchHeadOptions = {
  /** The installation access token authenticating the call. */
  readonly token: string;
  /** `"owner/repo"`. */
  readonly repo: string;
  /** Branch name without `refs/heads/` (e.g. `main`, `release/2026-09`). */
  readonly branch: string;
  /** API base override (tests / GHE). */
  readonly apiBase?: string;
  /** `fetch` override — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

/**
 * Build the ref request URL — pure, for unit testing. Each branch segment is
 * encoded on its own: the slashes in `release/2026-09` are part of the ref
 * path GitHub expects, and a dot segment is refused for the same reason
 * `repoContentsUrl` refuses one (the URL parser would resolve it away).
 */
export const branchRefUrl = (opts: {
  readonly repo: string;
  readonly branch: string;
  readonly apiBase?: string;
}): string => {
  const { owner, name } = splitRepo(opts.repo);
  const { apiBase } = resolveClient(opts);
  const segments = opts.branch.split("/");
  if (segments.some((s) => s.length === 0 || s === "." || s === "..")) {
    throw new GithubApiError(`malformed branch name "${opts.branch}"`, 0, "");
  }
  return `${apiBase}/repos/${owner}/${name}/git/ref/heads/${segments.map(encodeURIComponent).join("/")}`;
};

/**
 * The branch's head commit SHA (40 hex).
 *
 * @throws {GithubApiError} on any non-2xx (404 for a missing branch), and on a
 *   200 whose body is not a commit ref — GitHub answers a *prefix* match on this
 *   endpoint with an array, which names no single head.
 */
export const readBranchHead = async (opts: ReadBranchHeadOptions): Promise<string> => {
  const { doFetch } = resolveClient(opts);
  const res = await doFetch(branchRefUrl(opts), { method: "GET", headers: ghHeaders(opts.token) });
  await assertOk(res, `ref read failed for ${opts.repo}:heads/${opts.branch}`);
  const body: unknown = await res.json();
  const sha =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as { object?: { sha?: unknown } }).object?.sha
      : undefined;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new GithubApiError(
      `ref read for ${opts.repo}:heads/${opts.branch} named no single commit`,
      res.status,
      "",
    );
  }
  return sha;
};
