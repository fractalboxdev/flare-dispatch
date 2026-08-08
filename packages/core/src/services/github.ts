// @fractalboxdev/flare-dispatch-core — the `github` capability (read-only GitHub access).
//
// The symmetric *read* surface to the `Checks` capability's write side
// (check-runs callback). Scoped to the installations of the FlareDispatch
// GitHub App; runs never see a token — the live Layer mints, caches, and
// scopes them via the same installation-token machinery the Checks Layer
// uses (`@fractalboxdev/flare-dispatch-github-app`).
//
// Deliberately read-only and narrow: a run produces `findings` and an
// output, and the Dispatcher renders the check-run. The capability exists
// so a run can *discover what to act on* (Schedule-mode enumeration:
// "every open PR across every installed repo"), not so it can act on GitHub
// directly.
//
// Spec: specs/03-dsl.md § github, specs/04-gha-integration.md § Schedule mode.

import { Context, Effect } from "effect";
import type { GitHubApiError } from "../errors";

/** A repository the FlareDispatch App is installed on. */
export type RepoRef = {
  /** "owner/name". */
  readonly repo: string;
  readonly branchDefault: string;
  readonly installationId: number;
  readonly archived: boolean;
  /** epoch ms — last push to any branch. */
  readonly pushedAt: number;
};

/** An open pull request — the unit of work for `pr-review-sweep`. */
export type PullRequestRef = {
  /** "owner/name". */
  readonly repo: string;
  readonly number: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly title: string;
  readonly draft: boolean;
  readonly labels: readonly string[];
  readonly author: string;
  readonly installationId: number;
  /** epoch ms. */
  readonly updatedAt: number;
};

/**
 * A GitHub Actions workflow run — the unit of work for `ci-triage`. The read
 * surface a Schedule-mode run enumerates to find recently-failed CI across the
 * repos the App is installed on.
 */
export type WorkflowRunRef = {
  /** "owner/name". */
  readonly repo: string;
  /** The workflow run id (`GET /repos/{o}/{r}/actions/runs/{id}`). */
  readonly id: number;
  /** The workflow file's display name (e.g. "CI/CD"). */
  readonly name: string;
  /** The head branch the run executed on. */
  readonly headBranch: string;
  /** The head SHA the run executed against. */
  readonly headSha: string;
  /** GitHub run status — `completed` for a finished run. */
  readonly status: string;
  /** The conclusion — `failure` / `timed_out` / `cancelled` / `success` / … */
  readonly conclusion: string;
  /** The run's web URL (the failing-run link a triage write-up points at). */
  readonly url: string;
  /** epoch ms — when the run was created. */
  readonly createdAt: number;
};

/**
 * A request to open (or update) a **draft pull request** carrying a set of
 * file edits — the one *content write* on the `github` capability, added for
 * the `spec-drift` / `ci-triage` recipes. The live Layer commits the files via
 * the GitHub Git Data API (blob → tree → commit → ref) from the Worker — no
 * container `git push` — then opens a draft PR. Idempotent on `headBranch`:
 * re-running updates the branch and reuses the already-open PR.
 *
 * Like `pullReview`, this is a deliberate, narrow exception to the capability's
 * read-only stance — a recipe whose entire purpose is "detect X, propose a fix
 * as a PR" needs exactly this and nothing more (it never force-merges, never
 * touches protected refs).
 */
export type OpenDraftPullRequest = {
  /** "owner/name". */
  readonly repo: string;
  /**
   * The base branch to open the PR against and branch the commit from.
   * Defaults to the repo's default branch when omitted.
   */
  readonly baseBranch?: string;
  /** The head branch to create/update (e.g. `flare-dispatch/spec-drift-2026-06-03`). */
  readonly headBranch: string;
  /** PR title. */
  readonly title: string;
  /** PR body (markdown). */
  readonly body: string;
  /** The commit message for the file edits. */
  readonly commitMessage: string;
  /** The files to write — full new contents, keyed by repo-relative path. */
  readonly files: readonly { readonly path: string; readonly content: string }[];
  /**
   * Open the PR as a draft. Defaults to `true` (the spec-drift / ci-triage
   * recipes want a draft a human promotes). The `release-notes` recipe opens a
   * NON-draft PR (`draft: false`) so "merge to approve" is a one-click action.
   */
  readonly draft?: boolean;
  /**
   * The GitHub installation id authenticating the writes. Optional — the live
   * Layer resolves it from the repo when absent (the App is the source of truth
   * for which installation covers a repo).
   */
  readonly installationId?: number;
};

/** The outcome of {@link GithubService.openDraftPullRequest}. */
export type DraftPullRequestResult = {
  /** The PR number (existing or newly opened). */
  readonly number: number;
  /** The PR's web URL. */
  readonly url: string;
  /** `true` when this call opened a new PR; `false` when it updated an open one. */
  readonly created: boolean;
};

/**
 * A request to publish a **GitHub Release** — the narrow *release write* the
 * `release-notes` recipe uses on approval. Like `openDraftPullRequest` and
 * `pullReview`, this is a deliberate, bounded exception to the capability's
 * read-only stance: a run that drafts release notes and waits for a human gate
 * needs exactly "publish this tag with this body" and nothing more.
 *
 * The live Layer creates the release via `POST /repos/{o}/{r}/releases`, which
 * also creates the git tag at `target` when it does not exist — no separate
 * container `git push --tags`. A deploy without App credentials degrades to a
 * logged no-op (`published: false`), mirroring the other writes.
 */
export type CreateRelease = {
  /** "owner/name". */
  readonly repo: string;
  /** The tag to create/point the release at (e.g. `v0.1.0`). */
  readonly tag: string;
  /**
   * The commit sha (or branch) the tag is created at when it does not already
   * exist — pin it to the drafted HEAD sha for a reproducible tag. Defaults to
   * the repo's default-branch tip when omitted.
   */
  readonly target?: string;
  /** The release title — defaults to `tag`. */
  readonly name?: string;
  /** The release body (markdown). */
  readonly body: string;
  /** Publish as a pre-release. Default `false`. */
  readonly prerelease?: boolean;
  /**
   * The GitHub installation id authenticating the write. Optional — the live
   * Layer resolves it from the repo when absent.
   */
  readonly installationId?: number;
};

/** The outcome of {@link GithubService.createRelease}. */
export type ReleaseResult = {
  /** The release's numeric id (`0` when degraded to a no-op). */
  readonly id: number;
  /** The release's web URL (`""` when degraded to a no-op). */
  readonly url: string;
  /** The tag the release points at. */
  readonly tag: string;
  /** `true` when a release was actually published; `false` on a no-op deploy. */
  readonly published: boolean;
};

/**
 * A request to read **one text file** out of a repo — `readTextFile`.
 *
 * Narrow on purpose: this is not a filesystem, and it never becomes one. The
 * maintenance loop's suppression ledger lives in git in a private repo, and a
 * run that has to clone a repo to read one line on every cron tick pays a
 * container for a string. Everything wider already has a home — a run that
 * needs a working tree clones one (`workspace`), and writes go through
 * `openDraftPullRequest`.
 */
export type ReadTextFileRequest = {
  /** "owner/name". */
  readonly repo: string;
  /** Repo-relative path (e.g. `infra/maintenance-loop/declined.jsonl`). */
  readonly path: string;
  /** Branch, tag, or sha. Defaults to the repo's default branch. */
  readonly ref?: string;
  /**
   * The GitHub installation id authenticating the read. Optional — the live
   * Layer resolves it from the repo when absent, which is what a cron tick
   * (carrying no webhook payload) always needs.
   */
  readonly installationId?: number;
};

/**
 * The outcome of {@link GithubService.readTextFile}.
 *
 * Absent is a **value**, not a failure: a ledger nobody has written yet is
 * `{ found: false }`, and a caller must be able to tell that apart from "GitHub
 * returned 500" (a `GitHubApiError`) because the two demand opposite behavior.
 * A path that exists but is not a file (a directory) reads as `found: false`
 * too — it is not the text file that was asked for.
 */
export type TextFileResult =
  | { readonly found: true; readonly content: string }
  | { readonly found: false };

/**
 * A pull request as {@link GithubService.pullRequestHistory} returns it —
 * **including closed ones**, and carrying the two timestamps that date a
 * decision.
 *
 * Distinct from {@link PullRequestRef} (the open-PR sweep's unit of work)
 * because the questions differ: a sweep asks "what is in flight", history asks
 * "was this proposed before, and what happened to it". History therefore
 * carries `body` (where a proposal's `maintenance-key` lines live) and
 * `closedAt`, and `PullRequestRef` carries the head/base shas a review needs.
 */
export type PullRequestHistoryRef = {
  /** "owner/name". */
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  /** The PR body — a proposal's machine-readable lines ride here. */
  readonly body: string;
  /** The head branch name (no `owner:` prefix). */
  readonly headBranch: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  /** The PR's web URL. */
  readonly url: string;
  /** epoch ms. */
  readonly createdAt: number;
  /** epoch ms — resets on ANY touch; never date a cooldown from this. */
  readonly updatedAt: number;
  /** epoch ms — `undefined` while open. The one field that dates a decision. */
  readonly closedAt?: number;
  /** epoch ms — `undefined` unless merged. Closed-and-merged ≠ closed-unmerged. */
  readonly mergedAt?: number;
};

/**
 * A top-level PR review to post — `POST /repos/{o}/{r}/pulls/{n}/reviews`.
 * `event: "COMMENT"` leaves a visible review comment without approving or
 * requesting changes (the run's *verdict* is reported separately via the
 * check-run). This is the one *write* on the `github` capability — it exists so
 * a run can leave an always-visible PR comment (on success AND failure), which
 * the read-only check-run summary alone does not guarantee.
 */
export type PullReviewRequest = {
  /** "owner/name". */
  readonly repo: string;
  /** PR number. */
  readonly pr: number;
  /** Head SHA the review is anchored to. */
  readonly sha: string;
  /** Markdown body of the review comment. */
  readonly body: string;
  /**
   * The GitHub installation id authenticating the write. A run carries it as an
   * input (the webhook payload's `installation.id`); the live Layer mints the
   * installation token from it. Omitted in local dev → the no-op Layer.
   */
  readonly installationId?: number;
};

/** The service contract a runtime Layer implements. */
export interface GithubService {
  /**
   * Every repo the App is installed on — the enumeration surface for
   * Schedule-mode runs whose unit of work is a repo.
   */
  readonly repositories: (opts?: {
    includeArchived?: boolean;
    pushedWithinDays?: number;
  }) => Effect.Effect<readonly RepoRef[], GitHubApiError>;

  /**
   * Open PRs across every repo the App is installed on. Paginates internally
   * and backs off on secondary rate limits. The primary surface
   * Schedule-mode sweeps enumerate against — a cron tick names no target,
   * so the run must discover them.
   */
  readonly openPullRequests: (opts?: {
    updatedWithinHours?: number;
    includeDrafts?: boolean;
    repos?: readonly string[];
  }) => Effect.Effect<readonly PullRequestRef[], GitHubApiError>;

  /**
   * Recent GitHub Actions workflow runs across the App's installations — the
   * enumeration surface `ci-triage` scans for failures. `status` defaults to
   * `completed`; pass `conclusion: "failure"` to narrow to failed runs.
   * Paginates internally and backs off on secondary rate limits.
   */
  readonly actionRuns: (opts?: {
    /** Restrict to these repos (else every installed repo). */
    repos?: readonly string[];
    /** Only runs created within this window. */
    createdWithinHours?: number;
    /** GitHub run status filter — defaults to `completed`. */
    status?: string;
    /** Only runs with this conclusion (e.g. `failure`). */
    conclusion?: string;
  }) => Effect.Effect<readonly WorkflowRunRef[], GitHubApiError>;

  /**
   * A repo's PRs, **closed ones included**, newest-touched first — the read a
   * caller needs to ask "was this proposed before, and did a human close it
   * unmerged, and when". `openPullRequests` cannot answer it and must not
   * pretend to; this is the separate question. Paginates internally (bounded by
   * `updatedSince` and a page cap) and backs off on secondary rate limits.
   *
   * `headBranchPrefix` filters on the head branch — dated proposal branches
   * (`flare-dispatch/spec-audit-questions-2026-08-08`) share a prefix and
   * nothing else, and GitHub's own `head=` parameter matches one exact branch.
   */
  readonly pullRequestHistory: (opts: {
    /** "owner/name" — one repo; history is asked about a known place. */
    repo: string;
    /** Keep only PRs whose head branch starts with this. */
    headBranchPrefix?: string;
    /** `open` | `closed` | `all` — defaults to `all`. */
    state?: "open" | "closed" | "all";
    /**
     * Stop paginating past PRs last updated before this many days ago. A
     * pagination bound only — `updatedAt >= closedAt` always, so nothing closed
     * inside the window is missed, and every date the caller reasons about
     * still comes from `closedAt`.
     */
    updatedWithinDays?: number;
    /** Hard page cap (100 per page). */
    maxPages?: number;
    /** Installation authenticating the read; resolved from the repo when absent. */
    installationId?: number;
  }) => Effect.Effect<readonly PullRequestHistoryRef[], GitHubApiError>;

  /**
   * Read one text file from a repo at an optional ref. `{ found: false }` for a
   * path that is not there — the answer a not-yet-written ledger gives, which a
   * caller must be able to tell apart from an API failure.
   */
  readonly readTextFile: (
    req: ReadTextFileRequest,
  ) => Effect.Effect<TextFileResult, GitHubApiError>;

  /**
   * Post a top-level PR review comment (`event: "COMMENT"`). The run uses this
   * to leave an always-visible comment on every review — success or failure.
   * Best-effort reporting: a live deploy without App credentials degrades to a
   * logged no-op rather than failing the run.
   */
  readonly pullReview: (req: PullReviewRequest) => Effect.Effect<void, GitHubApiError>;

  /**
   * Open (or update) a draft PR carrying a set of file edits — the content
   * write the `spec-drift` / `ci-triage` recipes use to propose a fix. Commits
   * via the Git Data API from the Worker; idempotent on `headBranch`. A deploy
   * without App credentials degrades to a logged no-op (`created: false`).
   */
  readonly openDraftPullRequest: (
    req: OpenDraftPullRequest,
  ) => Effect.Effect<DraftPullRequestResult, GitHubApiError>;

  /**
   * Publish a GitHub Release (creating the tag at `target` when absent) — the
   * release write the `release-notes` recipe calls on human approval. A deploy
   * without App credentials degrades to a logged no-op (`published: false`).
   */
  readonly createRelease: (req: CreateRelease) => Effect.Effect<ReleaseResult, GitHubApiError>;
}

/** Context.Tag — the dependency a run carries until a Layer provides it. */
export class Github extends Context.Tag("@fractalboxdev/flare-dispatch-core/Github")<
  Github,
  GithubService
>() {}

/**
 * The `github` accessor namespace. Each function reads the Github service
 * from context and delegates — so a run writes `github.openPullRequests(...)`
 * rather than `Effect.flatMap(Github, (g) => g.openPullRequests(...))`.
 */
export const github = {
  repositories: (opts: { includeArchived?: boolean; pushedWithinDays?: number } = {}) =>
    Effect.flatMap(Github, (g) => g.repositories(opts)),
  openPullRequests: (
    opts: {
      updatedWithinHours?: number;
      includeDrafts?: boolean;
      repos?: readonly string[];
    } = {},
  ) => Effect.flatMap(Github, (g) => g.openPullRequests(opts)),
  actionRuns: (
    opts: {
      repos?: readonly string[];
      createdWithinHours?: number;
      status?: string;
      conclusion?: string;
    } = {},
  ) => Effect.flatMap(Github, (g) => g.actionRuns(opts)),
  pullRequestHistory: (opts: {
    repo: string;
    headBranchPrefix?: string;
    state?: "open" | "closed" | "all";
    updatedWithinDays?: number;
    maxPages?: number;
    installationId?: number;
  }) => Effect.flatMap(Github, (g) => g.pullRequestHistory(opts)),
  readTextFile: (req: ReadTextFileRequest) => Effect.flatMap(Github, (g) => g.readTextFile(req)),
  pullReview: (req: PullReviewRequest) => Effect.flatMap(Github, (g) => g.pullReview(req)),
  openDraftPullRequest: (req: OpenDraftPullRequest) =>
    Effect.flatMap(Github, (g) => g.openDraftPullRequest(req)),
  createRelease: (req: CreateRelease) => Effect.flatMap(Github, (g) => g.createRelease(req)),
} as const;
