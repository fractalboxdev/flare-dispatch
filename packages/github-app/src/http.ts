// @fractalbox/flare-dispatch-github-app — shared REST plumbing.
//
// The bits every github-app fetch module repeated: the API host + version, the
// `owner/repo` splitter, the installation-token header set, the `fetchImpl ??
// fetch` / `apiBase ?? base` resolution, and the non-2xx → `GithubApiError`
// guard. One home so the `X-GitHub-Api-Version` string (a deprecation-sensitive
// constant) lives in exactly one place.
//
// Provider-neutral plain `async`, no Effect — same property the rest of the
// package keeps so the Effect Layer in @fractalbox/flare-dispatch-runtime-cf can wrap it.

import { GithubApiError } from "./errors";

/** GitHub's API host — overridable per call for tests / GitHub Enterprise. */
export const DEFAULT_API_BASE = "https://api.github.com";

/** The GitHub REST API version every call pins. Bump in one place. */
const GITHUB_API_VERSION = "2022-11-28";

/** Split an `"owner/repo"` slug; throws on a malformed slug. */
export const splitRepo = (repo: string): { owner: string; name: string } => {
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash === repo.length - 1) {
    throw new GithubApiError(`malformed repo slug "${repo}"`, 0, "");
  }
  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
};

/**
 * Request headers for a Bearer-authenticated call (installation token OR App
 * JWT — both are `Authorization: Bearer`). Pass `{ json: true }` for a request
 * that carries a JSON body (POST/PATCH).
 */
export const ghHeaders = (
  token: string,
  opts: { json?: boolean } = {},
): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  ...(opts.json ? { "Content-Type": "application/json" } : {}),
  "X-GitHub-Api-Version": GITHUB_API_VERSION,
  "User-Agent": "flare-dispatch",
});

/** Resolve the per-call `apiBase` + `fetch` defaults in one place. */
export const resolveClient = (opts: {
  apiBase?: string;
  fetchImpl?: typeof fetch;
}): { apiBase: string; doFetch: typeof fetch } => ({
  apiBase: opts.apiBase ?? DEFAULT_API_BASE,
  doFetch: opts.fetchImpl ?? fetch,
});

/**
 * Throw a `GithubApiError` (status + body text attached) when a response is
 * non-2xx. Each caller keeps its own success-body decode after this guard, so
 * decode semantics (strict vs tolerant) stay per-call.
 */
export const assertOk = async (
  res: Response,
  message: string,
): Promise<void> => {
  if (!res.ok) {
    throw new GithubApiError(
      message,
      res.status,
      await res.text().catch(() => ""),
    );
  }
};
