// @fractalboxdev/flare-dispatch-runtime-cf — GitlabScmLive: the live `scm` capability (GitLab).
//
// Backs the neutral `Scm` Tag with the GitLab REST API via
// `@fractalboxdev/flare-dispatch-gitlab-app`. `fetchDiff` maps a `ChangeRef` onto the MR diff
// endpoint (`project` → project id/path, `number` → the MR `iid`) and assembles
// a unified diff; `postReview` posts a top-level note and returns its id;
// `updateReview` edits that note in place. A project access token
// (the `GITLAB_TOKEN` Worker secret) is the auth — see gitlab-app's README.
//
// --- Graceful degradation (mirrors makeGithubLive's pullReview degrade) ------
//
// When the token is ABSENT (a deploy without `GITLAB_TOKEN`): `postReview` is a
// logged no-op returning `{ noteId: null }` and `updateReview` is a logged
// no-op — a review note is *reporting*, never *correctness*, so it must not
// fail an otherwise-green run — and `fetchDiff` fails with a typed `ScmError`
// (`reason: "auth-failed"`), since a review with no diff to read cannot
// proceed. With the token present, a genuine API failure is a typed `ScmError`
// the run's error boundary renders.
//
// --- Error mapping -----------------------------------------------------------
//
// `gitlab-app`'s `GitlabApiError` carries an HTTP status; `scmReasonFor` maps it
// (and any other thrown value) onto the provider-agnostic `ScmError.reason`
// union — no HTTP status leaks past this Layer, exactly like the modelGateway /
// github layers. A 404 on `updateReview` (the note was deleted) maps to
// `reason: "not-found"` — the caller's own fallback (create a fresh note)
// decides what to do with that.

import {
  fetchMergeRequestDiff,
  postMergeRequestNote,
  updateMergeRequestNote,
  GitlabApiError,
} from "@fractalboxdev/flare-dispatch-gitlab-app";
import { Effect, Layer } from "effect";
import {
  type ChangeRef,
  type FetchDiffResult,
  type PostReviewResult,
  Scm,
  ScmError,
  type ScmService,
} from "@fractalboxdev/flare-dispatch-core";

const PROVIDER = "gitlab";

/** Normalize a configured token to `undefined` when it is `undefined`, `""`,
 *  or whitespace-only — every shape of "no real token configured" the
 *  degraded Layer must treat the same way. A deploy that sets
 *  `GITLAB_TOKEN=""` (an unset env var Wrangler still binds as an empty
 *  string, or a blanked-out secret) must degrade exactly like a deploy that
 *  never set it at all — not attempt (and fail) a live API call. Done ONCE
 *  here so every branch below keeps ordinary `token === undefined` narrowing. */
const normalizeToken = (token: string | undefined): string | undefined => {
  const trimmed = token?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : undefined;
};

/** Same blank-collapsing + trim treatment as {@link normalizeToken}, for the
 *  API base override — a blank `GITLAB_API_BASE` (an unset env var Wrangler
 *  still binds as `""`, or a blanked-out one) must fall back to
 *  `resolveClient`'s `DEFAULT_API_BASE`, not pass an empty string through as
 *  a literal `apiBase: ""` (which `?? DEFAULT_API_BASE` does NOT catch —
 *  `??` only falls back on `null`/`undefined`). */
const normalizeBaseUrl = (url: string | undefined): string | undefined => {
  const trimmed = url?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : undefined;
};

/**
 * Map a thrown value onto the provider-agnostic `ScmError.reason`:
 *   401 / 403 → auth-failed, 404 → not-found, 429 → rate-limited,
 *   any other `GitlabApiError` → bad-response, a non-API throw → unknown.
 * PURE — exported for direct unit testing (the logic-heavy seam).
 */
export const scmReasonFor = (cause: unknown): ScmError["reason"] => {
  if (cause instanceof GitlabApiError) {
    if (cause.status === 401 || cause.status === 403) return "auth-failed";
    if (cause.status === 404) return "not-found";
    if (cause.status === 429) return "rate-limited";
    return "bad-response";
  }
  return "unknown";
};

/** Coerce a thrown value into a typed `ScmError`. */
const toScmError = (cause: unknown): ScmError => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new ScmError({
    provider: PROVIDER,
    reason: scmReasonFor(cause),
    message,
  });
};

/** The config the live GitLab `Scm` Layer needs. */
export type GitlabScmConfig = {
  /**
   * The GitLab project/group access token (`GITLAB_TOKEN`). `undefined` selects
   * the degraded Layer: `postReview`/`updateReview` no-op, `fetchDiff` fails
   * `auth-failed`.
   */
  readonly token?: string;
  /** API base override (`https://gitlab.com/api/v4` default) for self-hosted. */
  readonly baseUrl?: string;
};

/**
 * Build the live GitLab `Scm` Layer. Absent a token, the Layer degrades:
 * `fetchDiff` fails with `ScmError(auth-failed)`, `postReview` is a logged
 * no-op returning `{ noteId: null }`, and `updateReview` is a logged no-op.
 */
export const makeGitlabScmLive = (
  config: GitlabScmConfig,
): Layer.Layer<Scm> => {
  const token = normalizeToken(config.token);
  const baseUrl = normalizeBaseUrl(config.baseUrl);

  const service: ScmService = {
    fetchDiff: (ref: ChangeRef) =>
      token === undefined
        ? Effect.fail(
            new ScmError({
              provider: PROVIDER,
              reason: "auth-failed",
              message:
                "scm.fetchDiff: no GITLAB_TOKEN on this deploy — cannot read the merge-request diff",
            }),
          )
        : Effect.tryPromise({
            try: async (): Promise<FetchDiffResult> => {
              const result = await fetchMergeRequestDiff({
                token,
                projectId: ref.project,
                iid: ref.number,
                ...(baseUrl !== undefined ? { apiBase: baseUrl } : {}),
              });
              return { diff: result.diff, truncated: result.truncated, pages: result.pages };
            },
            catch: toScmError,
          }),

    postReview: (note) =>
      token === undefined
        ? Effect.logInfo(
            `scm.postReview skipped (no GITLAB_TOKEN) — note on ${note.ref.project}!${note.ref.number} not posted`,
          ).pipe(Effect.as({ noteId: null } satisfies PostReviewResult))
        : Effect.tryPromise({
            try: async (): Promise<PostReviewResult> => ({
              noteId: await postMergeRequestNote({
                token,
                projectId: note.ref.project,
                iid: note.ref.number,
                body: note.body,
                ...(baseUrl !== undefined ? { apiBase: baseUrl } : {}),
              }),
            }),
            catch: toScmError,
          }),

    updateReview: (note) =>
      token === undefined
        ? Effect.logInfo(
            `scm.updateReview skipped (no GITLAB_TOKEN) — note ${note.noteId} on ${note.ref.project}!${note.ref.number} not updated`,
          )
        : Effect.tryPromise({
            try: () =>
              updateMergeRequestNote({
                token,
                projectId: note.ref.project,
                iid: note.ref.number,
                noteId: note.noteId,
                body: note.body,
                ...(baseUrl !== undefined ? { apiBase: baseUrl } : {}),
              }),
            catch: toScmError,
          }),
  };

  return Layer.succeed(Scm, service);
};
