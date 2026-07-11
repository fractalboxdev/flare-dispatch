// @fractalbox/flare-dispatch-github-app — error type.
//
// The github-app package is the low-level HTTP layer: plain typed `async`
// functions, no Effect dependency (the Effect wrapping happens one layer up in
// `ChecksGithubLive`). It surfaces a single concrete error class so callers can
// `instanceof`-narrow on it; the Effect Layer maps this onto a tagged error.

/** Thrown when a GitHub API call returns a non-2xx response. */
export class GithubApiError extends Error {
  override readonly name = "GithubApiError";

  constructor(
    message: string,
    /** The HTTP status code GitHub returned. */
    readonly status: number,
    /** The (possibly empty) response body, for diagnostics. */
    readonly body: string,
  ) {
    super(`${message} (HTTP ${status})`);
  }
}
