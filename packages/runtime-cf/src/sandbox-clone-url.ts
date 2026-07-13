// Pure helpers for the `Sandbox` Layer's clone-URL handling. Kept out of
// `sandbox-cf.ts` so unit tests can exercise them without pulling in the
// `@cloudflare/sandbox` runtime import (which only resolves under
// `vitest-pool-workers` / a live Workers env).

/** Build a clone URL from an `owner/name` slug. */
export const repoUrl = (repo: string): string =>
  repo.startsWith("http") ? repo : `https://github.com/${repo}.git`;

/**
 * Embed a GitHub App installation token into an HTTPS GitHub clone URL using
 * the documented `x-access-token` basic-auth shape:
 *
 *   https://x-access-token:<token>@github.com/<owner>/<name>.git
 *
 * Only HTTPS `github.com` URLs are rewritten — a custom http(s) URL the caller
 * passed directly (mirror, GHE host, etc.) is returned unchanged so the auth
 * shape never silently overrides an operator-supplied URL. SSH URLs are also
 * left alone: they authenticate via key, not via an App token.
 */
export const authenticateCloneUrl = (url: string, token: string): string =>
  url.startsWith("https://github.com/")
    ? url.replace(
        "https://github.com/",
        `https://x-access-token:${token}@github.com/`,
      )
    : url;
