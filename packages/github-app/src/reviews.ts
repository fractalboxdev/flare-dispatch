// @fractalbox/flare-dispatch-github-app — PR review (comment) create.
//
// `createPullReview` posts a top-level review on a PR:
//   POST /repos/{owner}/{repo}/pulls/{number}/reviews  { event, body, commit_id }
//
// The `pr-review` run uses `event: "COMMENT"` to leave an always-visible
// comment on every review (success AND failure) without approving / blocking —
// the run's verdict is reported separately via the check-run conclusion.
//
// Authenticated with an installation access token (installation-token.ts) —
// never an App JWT, never a PAT. Provider-neutral plain `async`; the Effect
// Layer (`makeGithubLive` in @fractalbox/flare-dispatch-runtime-cf) wraps it.

import { assertOk, ghHeaders, resolveClient, splitRepo } from "./http";

/** The review event family GitHub accepts on `POST .../reviews`. */
export type PullReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export type CreatePullReviewOptions = {
  /** The installation access token authenticating the call. */
  readonly token: string;
  /** `"owner/repo"`. */
  readonly repo: string;
  /** PR number. */
  readonly pr: number;
  /** Head SHA the review is anchored to (`commit_id`). */
  readonly sha: string;
  /** Markdown review body. */
  readonly body: string;
  /** Review event — defaults to `COMMENT` (visible, non-blocking). */
  readonly event?: PullReviewEvent;
  /** API base override (tests / GHE). */
  readonly apiBase?: string;
  /** `fetch` override — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

/**
 * Post a top-level PR review.
 *
 * @throws {GithubApiError} when the API returns non-2xx.
 */
export const createPullReview = async (
  opts: CreatePullReviewOptions,
): Promise<void> => {
  const { owner, name: repoName } = splitRepo(opts.repo);
  const { apiBase, doFetch } = resolveClient(opts);

  const res = await doFetch(
    `${apiBase}/repos/${owner}/${repoName}/pulls/${opts.pr}/reviews`,
    {
      method: "POST",
      headers: ghHeaders(opts.token, { json: true }),
      body: JSON.stringify({
        commit_id: opts.sha,
        body: opts.body,
        event: opts.event ?? "COMMENT",
      }),
    },
  );

  await assertOk(res, "pull review create failed");
};
