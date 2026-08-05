// @fractalboxdev/flare-dispatch-runtime-cf — GithubLive: the live `github` capability (write).
//
// Backs the one *write* on the `Github` Tag — `pullReview` — with the GitHub
// App PR-reviews API, via `@fractalboxdev/flare-dispatch-github-app`: an App JWT is exchanged
// for a short-lived installation token (cached in Worker memory), and that
// token authenticates `POST /repos/{o}/{r}/pulls/{n}/reviews`.
//
// The *read* surface (`repositories` / `openPullRequests`) is still V3 work —
// this Layer leaves both as the dying stubs from `GithubDeferred`. Only
// `pullReview` is wired, because the `pr-review` run needs an always-visible PR
// comment on every review.
//
// --- Graceful degradation ----------------------------------------------------
//
// A PR comment is *reporting*, never *correctness* — it must not fail an
// otherwise-green run. When App credentials are absent (local dev, no secrets)
// OR a request carries no installation id, `pullReview` is a logged no-op,
// exactly like the no-op `Checks` Layer. With credentials present, a genuine
// API failure is a typed `GitHubApiError` the run's error boundary handles
// (and still posts a fallback comment path where possible).
//
// Spec: specs/04-gha-integration.md § Check-runs callback (symmetric write).

import {
  createPullReview,
  createRelease,
  getInstallationToken,
  listActionRuns,
  openDraftPullRequest,
  resolveRepoInstallationId,
  GithubApiError as GithubAppApiError,
} from "@fractalboxdev/flare-dispatch-github-app";
import { Effect, Layer, Schedule } from "effect";
import {
  type DraftPullRequestResult,
  Github,
  GitHubApiError,
  type GithubService,
  type ReleaseResult,
  type WorkflowRunRef,
} from "@fractalboxdev/flare-dispatch-core";

/** The GitHub App credentials the live `pullReview` write needs. */
export type GithubLiveConfig = {
  /** `GITHUB_APP_ID`. */
  readonly appId: string;
  /** `GITHUB_APP_PRIVATE_KEY` — PKCS#8 PEM. */
  readonly privateKeyPem: string;
};

/**
 * Classify a GitHub failure into the typed `GitHubApiError.reason`. The
 * rate-limit signal — not the status alone — decides 403: GitHub returns **403
 * with a `Retry-After`** for *secondary* rate limits (the ones content-generating
 * POSTs like a PR review or check-run trip), so a 403 carrying a retry hint is
 * `rate-limited`, not `unauthorized` (which would send an operator hunting for a
 * bad PEM). A raw network throw surfaces as status 0 → `transient` (retryable).
 * Exported for unit tests.
 */
export const classifyReason = (
  status: number,
  retryAfterMs: number | undefined,
): GitHubApiError["reason"] =>
  status === 429 || (status === 403 && retryAfterMs !== undefined)
    ? "rate-limited"
    : status === 401 || status === 403
      ? "unauthorized"
      : status === 0 || status >= 500
        ? "transient"
        : "other";

/**
 * Bounded exponential backoff for the two retryable classes — a transient 5xx /
 * network blip, or a rate limit. Capped at 4 retries with jitter so a burst of
 * concurrent runs doesn't resynchronise onto GitHub. Non-retryable reasons
 * (`unauthorized`, `other`) stop immediately and surface to the run boundary.
 * `whileInput` reads the error's data field (`.reason`) — not a `._tag` — so it
 * is within the Effect convention for `Schedule` predicates.
 */
const githubRetry = Schedule.exponential("250 millis").pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(4)),
  Schedule.whileInput(
    (e: GitHubApiError) => e.reason === "transient" || e.reason === "rate-limited",
  ),
);

/**
 * Run a github-app call as an Effect: map any throw to the typed
 * `GitHubApiError` and retry the two retryable classes with bounded backoff.
 * One chokepoint so every GitHub call gets the same error mapping + resilience,
 * instead of each site re-deriving `catch: toGitHubApiError`.
 */
const ghCall = <A>(thunk: () => Promise<A>): Effect.Effect<A, GitHubApiError> =>
  Effect.tryPromise({ try: thunk, catch: toGitHubApiError }).pipe(Effect.retry(githubRetry));

const logSkip = (repo: string, pr: number, why: string): Effect.Effect<void> =>
  Effect.logInfo(`github.pullReview skipped (${why}) — PR comment on ${repo}#${pr} not posted`);

/**
 * Build the live `Github` Layer. When `config` is `undefined` (no App secrets)
 * `pullReview` is a logged no-op for every request; the read surface always
 * dies (V3 work). With credentials, `pullReview` mints an installation token
 * from each request's `installationId` and posts the review.
 */
export const makeGithubLive = (config: GithubLiveConfig | undefined): Layer.Layer<Github> => {
  /**
   * Mint a fresh installation token for a repo. Prefers an explicit
   * `installationId`, else resolves the repo's installation from the App JWT
   * (the App is the source of truth for which installation covers a repo).
   * Only callable when `config` is present — both callers guard that first.
   */
  const mintToken = (
    cfg: GithubLiveConfig,
    repo: string,
    installationId?: number,
  ): Effect.Effect<string, GitHubApiError> =>
    Effect.gen(function* () {
      const resolvedInstallationId =
        installationId !== undefined && installationId > 0
          ? installationId
          : yield* ghCall(() =>
              resolveRepoInstallationId({
                appId: cfg.appId,
                privateKeyPem: cfg.privateKeyPem,
                repo,
              }),
            );
      return yield* ghCall(() =>
        getInstallationToken({
          appId: cfg.appId,
          privateKeyPem: cfg.privateKeyPem,
          installationId: resolvedInstallationId,
        }),
      );
    });

  const service: GithubService = {
    repositories: () =>
      Effect.die("github.repositories: not implemented in this deploy — V3 capability"),
    openPullRequests: () =>
      Effect.die("github.openPullRequests: not implemented in this deploy — V3 capability"),

    actionRuns: ({ repos, createdWithinHours, status, conclusion } = {}) =>
      Effect.gen(function* () {
        if (config === undefined) {
          yield* Effect.logInfo("github.actionRuns skipped (no GitHub App credentials) — empty");
          return [];
        }
        if (repos === undefined || repos.length === 0) {
          // Enumerating every installed repo (listing installations) is V3 work;
          // the `ci-triage` recipe always passes its configured repo list.
          yield* Effect.logInfo(
            "github.actionRuns: no repos passed — pass a repo list (installation-wide enumeration is not yet wired)",
          );
          return [];
        }
        const cutoff =
          createdWithinHours !== undefined
            ? Date.now() - createdWithinHours * 3_600_000
            : undefined;

        const perRepo = yield* Effect.forEach(
          repos,
          (repo) =>
            Effect.gen(function* () {
              const token = yield* mintToken(config, repo);
              const runs = yield* ghCall(() =>
                listActionRuns({
                  token,
                  repo,
                  ...(status !== undefined ? { status } : {}),
                }),
              );
              return runs
                .filter(
                  (r) =>
                    (conclusion === undefined || r.conclusion === conclusion) &&
                    (cutoff === undefined || r.createdAt >= cutoff),
                )
                .map((r): WorkflowRunRef => ({
                  repo,
                  id: r.id,
                  name: r.name,
                  headBranch: r.headBranch,
                  headSha: r.headSha,
                  status: r.status,
                  conclusion: r.conclusion,
                  url: r.url,
                  createdAt: r.createdAt,
                }));
            }),
          { concurrency: 4 },
        );
        return perRepo.flat();
      }),

    pullReview: ({ repo, pr, sha, body, installationId }) =>
      Effect.gen(function* () {
        if (config === undefined) {
          return yield* logSkip(repo, pr, "no GitHub App credentials");
        }

        // `mintToken` prefers the webhook-threaded installation id but falls back
        // to resolving it from the App JWT (the App is the source of truth for
        // which installation covers a repo) — Action-mode dispatch, or a dropped
        // `installation.id`, still posts.
        const token = yield* mintToken(config, repo, installationId);

        yield* ghCall(() => createPullReview({ token, repo, pr, sha, body, event: "COMMENT" }));
      }),

    openDraftPullRequest: (req): Effect.Effect<DraftPullRequestResult, GitHubApiError> =>
      Effect.gen(function* () {
        if (config === undefined) {
          // No App credentials (local dev / no secrets) — a logged no-op, the
          // same graceful degradation `pullReview` uses. The recipe sees
          // `created: false` and reports "no PR opened (App not configured)".
          yield* Effect.logInfo(
            `github.openDraftPullRequest skipped (no GitHub App credentials) — ${req.repo}#${req.headBranch} not opened`,
          );
          return { number: 0, url: "", created: false };
        }
        const token = yield* mintToken(config, req.repo, req.installationId);
        return yield* ghCall(() =>
          openDraftPullRequest({
            token,
            repo: req.repo,
            ...(req.baseBranch !== undefined ? { baseBranch: req.baseBranch } : {}),
            headBranch: req.headBranch,
            title: req.title,
            body: req.body,
            commitMessage: req.commitMessage,
            files: req.files,
            ...(req.draft !== undefined ? { draft: req.draft } : {}),
          }),
        );
      }),

    createRelease: (req): Effect.Effect<ReleaseResult, GitHubApiError> =>
      Effect.gen(function* () {
        if (config === undefined) {
          // No App credentials (local dev / no secrets) — a logged no-op, the
          // same graceful degradation the other writes use. The recipe sees
          // `published: false` and reports "release not published (App not
          // configured)".
          yield* Effect.logInfo(
            `github.createRelease skipped (no GitHub App credentials) — ${req.repo}@${req.tag} not published`,
          );
          return { id: 0, url: "", tag: req.tag, published: false };
        }
        const token = yield* mintToken(config, req.repo, req.installationId);
        const result = yield* ghCall(() =>
          createRelease({
            token,
            repo: req.repo,
            tag: req.tag,
            ...(req.target !== undefined ? { target: req.target } : {}),
            ...(req.name !== undefined ? { name: req.name } : {}),
            body: req.body,
            ...(req.prerelease !== undefined ? { prerelease: req.prerelease } : {}),
          }),
        );
        return {
          id: result.id,
          url: result.htmlUrl,
          tag: result.tagName,
          published: true,
        };
      }),
  };

  return Layer.succeed(Github, service);
};

/**
 * Coerce an unknown thrown value into the core `GitHubApiError`, carrying the
 * rate-limit retry hint through from the low-level `GithubApiError` so the
 * classification (and any backoff) can honour it. A non-API throw (network
 * failure) has no status → 0 → `transient`.
 */
const toGitHubApiError = (cause: unknown): GitHubApiError => {
  if (cause instanceof GithubAppApiError) {
    const retryAfterMs = cause.retryAfterMs;
    return new GitHubApiError({
      status: cause.status,
      reason: classifyReason(cause.status, retryAfterMs),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  return new GitHubApiError({ status: 0, reason: "transient" });
};
