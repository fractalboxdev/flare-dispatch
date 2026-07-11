// @fractalboxdev/flare-dispatch-core — Github fake (read-only GitHub access).
//
// In-memory fake of the `github` capability. Tests pre-populate the state with
// `repositories` / `pullRequests` arrays; the service applies the documented
// filters (archived skip, push age, draft skip, repo allow-list, update age)
// and returns the surviving rows. Call counts are recorded for assertions.
//
// A test that wants `github` to fail with `GitHubApiError` constructs its own
// failing `Github` Layer — the fake is the green-path simulator.

import { Effect, Layer } from "effect";
import {
  type CreateRelease,
  type DraftPullRequestResult,
  Github,
  type GithubService,
  type OpenDraftPullRequest,
  type PullRequestRef,
  type PullReviewRequest,
  type ReleaseResult,
  type RepoRef,
  type WorkflowRunRef,
} from "../services/github";

export type GithubFakeState = {
  /** Seeded repos — returned by `repositories` (after filtering). */
  repositories: RepoRef[];
  /** Seeded PRs — returned by `openPullRequests` (after filtering). */
  pullRequests: PullRequestRef[];
  /** Seeded workflow runs — returned by `actionRuns` (after filtering). */
  workflowRuns: WorkflowRunRef[];
  /** Every `repositories` call, in order. */
  readonly repositoriesCalls: Array<{
    includeArchived: boolean;
    pushedWithinDays?: number;
  }>;
  /** Every `openPullRequests` call, in order. */
  readonly openPullRequestsCalls: Array<{
    updatedWithinHours?: number;
    includeDrafts: boolean;
    repos?: readonly string[];
  }>;
  /** Every `actionRuns` call, in order. */
  readonly actionRunsCalls: Array<{
    repos?: readonly string[];
    createdWithinHours?: number;
    status?: string;
    conclusion?: string;
  }>;
  /** Every `pullReview` call, in order — lets a test assert a comment posted. */
  readonly pullReviewCalls: PullReviewRequest[];
  /** Every `openDraftPullRequest` call, in order. */
  readonly openDraftPullRequestCalls: OpenDraftPullRequest[];
  /** Every `createRelease` call, in order — lets a test assert a release published. */
  readonly createReleaseCalls: CreateRelease[];
};

/** Default reference clock — fakes use this when callers don't override. */
const DEFAULT_NOW = 1_700_000_000_000;

export const makeGithubFake = (
  opts: {
    repositories?: readonly RepoRef[];
    pullRequests?: readonly PullRequestRef[];
    workflowRuns?: readonly WorkflowRunRef[];
    /** Clock used to evaluate `pushedWithinDays` / `updatedWithinHours`. */
    now?: number;
  } = {},
): { layer: Layer.Layer<Github>; state: GithubFakeState } => {
  const state: GithubFakeState = {
    repositories: [...(opts.repositories ?? [])],
    pullRequests: [...(opts.pullRequests ?? [])],
    workflowRuns: [...(opts.workflowRuns ?? [])],
    repositoriesCalls: [],
    openPullRequestsCalls: [],
    actionRunsCalls: [],
    pullReviewCalls: [],
    openDraftPullRequestCalls: [],
    createReleaseCalls: [],
  };
  const now = opts.now ?? DEFAULT_NOW;
  // Branches the fake has already "opened" a PR for — so a re-run with the same
  // headBranch reports `created: false`, mirroring the live idempotency.
  const openedBranches = new Set<string>();

  const service: GithubService = {
    repositories: ({ includeArchived = false, pushedWithinDays } = {}) =>
      Effect.sync(() => {
        state.repositoriesCalls.push({ includeArchived, pushedWithinDays });
        return state.repositories.filter((r) => {
          if (!includeArchived && r.archived) return false;
          if (pushedWithinDays !== undefined) {
            const cutoff = now - pushedWithinDays * 86_400_000;
            if (r.pushedAt < cutoff) return false;
          }
          return true;
        });
      }),

    openPullRequests: ({
      updatedWithinHours,
      includeDrafts = false,
      repos,
    } = {}) =>
      Effect.sync(() => {
        state.openPullRequestsCalls.push({
          updatedWithinHours,
          includeDrafts,
          repos,
        });
        const allow = repos === undefined ? undefined : new Set(repos);
        return state.pullRequests.filter((pr) => {
          if (!includeDrafts && pr.draft) return false;
          if (allow !== undefined && !allow.has(pr.repo)) return false;
          if (updatedWithinHours !== undefined) {
            const cutoff = now - updatedWithinHours * 3_600_000;
            if (pr.updatedAt < cutoff) return false;
          }
          return true;
        });
      }),

    actionRuns: ({ repos, createdWithinHours, status, conclusion } = {}) =>
      Effect.sync(() => {
        state.actionRunsCalls.push({
          repos,
          createdWithinHours,
          status,
          conclusion,
        });
        const allow = repos === undefined ? undefined : new Set(repos);
        return state.workflowRuns.filter((r) => {
          if (allow !== undefined && !allow.has(r.repo)) return false;
          if (status !== undefined && r.status !== status) return false;
          if (conclusion !== undefined && r.conclusion !== conclusion)
            return false;
          if (createdWithinHours !== undefined) {
            const cutoff = now - createdWithinHours * 3_600_000;
            if (r.createdAt < cutoff) return false;
          }
          return true;
        });
      }),

    pullReview: (req) =>
      Effect.sync(() => {
        state.pullReviewCalls.push(req);
      }),

    openDraftPullRequest: (req): Effect.Effect<DraftPullRequestResult, never> =>
      Effect.sync(() => {
        state.openDraftPullRequestCalls.push(req);
        const key = `${req.repo}#${req.headBranch}`;
        const created = !openedBranches.has(key);
        openedBranches.add(key);
        // Deterministic fake PR number derived from call order.
        const number = state.openDraftPullRequestCalls.length;
        return {
          number,
          url: `https://github.com/${req.repo}/pull/${number}`,
          created,
        };
      }),

    createRelease: (req): Effect.Effect<ReleaseResult, never> =>
      Effect.sync(() => {
        state.createReleaseCalls.push(req);
        // Deterministic fake release id derived from call order.
        const id = state.createReleaseCalls.length;
        return {
          id,
          url: `https://github.com/${req.repo}/releases/tag/${req.tag}`,
          tag: req.tag,
          published: true,
        };
      }),
  };

  return { layer: Layer.succeed(Github, service), state };
};

/** A ready-to-use Github fake Layer — empty repos + PRs. */
export const GithubFake: Layer.Layer<Github> = makeGithubFake().layer;
