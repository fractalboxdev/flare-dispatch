// @fractalboxdev/flare-dispatch-core — Github fake (read-only GitHub access).
//
// In-memory fake of the `github` capability. Tests pre-populate the state with
// `issues` / `workflowRuns` / `pullRequestHistory` arrays and a `files`
// map; the service applies the documented filters (archived skip, push age,
// draft skip, repo allow-list, update age, head-branch prefix) and returns the
// surviving rows. Call counts are recorded for assertions.
//
// `pullRequestHistory` goes further than filtering, because its *shape* is part
// of the contract: it sorts newest-updated-first and walks pages under a cap,
// the way the live read's `sort=updated&direction=desc` + `maxPages` do. A fake
// that returned seeded insertion order and ignored the cap would let a caller
// depending on either pass its tests and paginate differently in production.
//
// A test that wants `github` to fail with `GitHubApiError` constructs its own
// failing `Github` Layer — the fake is the green-path simulator.

import { Effect, Layer } from "effect";
import {
  type CreateRelease,
  type DraftPullRequestResult,
  Github,
  type GithubService,
  type IssueRef,
  type OpenDraftPullRequest,
  type PullRequestHistoryRef,
  type PullReviewRequest,
  type ReadTextFileRequest,
  type ReleaseResult,
  type TextFileResult,
  type WorkflowRunRef,
} from "../services/github";

export type GithubFakeState = {
  /** Seeded issues — returned by `issues` (after filtering). */
  issues: IssueRef[];
  /** Seeded workflow runs — returned by `actionRuns` (after filtering). */
  workflowRuns: WorkflowRunRef[];
  /** Seeded PR history — returned by `pullRequestHistory` (after filtering). */
  pullRequestHistory: PullRequestHistoryRef[];
  /**
   * Seeded repo files answering `readTextFile`, keyed `"owner/name:path"` — or
   * `"owner/name@ref:path"` to pin one ref, which takes precedence when the
   * caller passes a matching `ref`.
   */
  files: Record<string, string>;
  /** Every `issues` call, in order. */
  readonly issuesCalls: Array<{
    repo: string;
    state: "open" | "closed" | "all";
    labels?: readonly string[];
    updatedWithinDays?: number;
  }>;
  /** Every `actionRuns` call, in order. */
  readonly actionRunsCalls: Array<{
    repos?: readonly string[];
    createdWithinHours?: number;
    status?: string;
    conclusion?: string;
  }>;
  /** Every `pullRequestHistory` call, in order. */
  readonly pullRequestHistoryCalls: Array<{
    repo: string;
    headBranchPrefix?: string;
    state: "open" | "closed" | "all";
    updatedWithinDays?: number;
    maxPages?: number;
  }>;
  /** Every `readTextFile` call, in order. */
  readonly readTextFileCalls: ReadTextFileRequest[];
  /** Every `pullReview` call, in order — lets a test assert a comment posted. */
  readonly pullReviewCalls: PullReviewRequest[];
  /** Every `openDraftPullRequest` call, in order. */
  readonly openDraftPullRequestCalls: OpenDraftPullRequest[];
  /** Every `createRelease` call, in order — lets a test assert a release published. */
  readonly createReleaseCalls: CreateRelease[];
  /** Every label ADD, in order. */
  readonly addIssueLabelsCalls: Array<{ repo: string; issue: number; labels: readonly string[] }>;
  /** Every label REMOVE, in order. */
  readonly removeIssueLabelCalls: Array<{ repo: string; issue: number; label: string }>;
  /** Every issue comment, in order — body included, so a test can assert the template. */
  readonly commentOnIssueCalls: Array<{ repo: string; issue: number; body: string }>;
  /** Every assignment, in order. */
  readonly assignIssueCalls: Array<{ repo: string; issue: number; assignees: readonly string[] }>;
  /**
   * Every close, in order. The only close there is, and it carries the link —
   * so `closeIssueAsDuplicateCalls` being empty IS the assertion that nothing
   * was closed, with no second close path to check.
   */
  readonly closeIssueAsDuplicateCalls: Array<{ repo: string; issue: number; duplicateOf: number }>;
};

/** Default reference clock — fakes use this when callers don't override. */
const NOW_DEFAULT = 1_700_000_000_000;

/**
 * Page size the live PR-history read requests (GitHub's maximum), and its hard
 * page cap — `listPullRequests`'s `PAGE_SIZE_DEFAULT` / `MAX_PAGES_DEFAULT`.
 *
 * The page size is seedable (`historyPageSize`) purely so `maxPages` is
 * assertable: at the real 100-per-page, no plausible test seeds enough rows for
 * the cap to bite, and a cap that no test can reach is a cap nothing pins.
 */
const HISTORY_PAGE_SIZE_DEFAULT = 100;
const HISTORY_MAX_PAGES_DEFAULT = 5;

export const makeGithubFake = (
  opts: {
    issues?: readonly IssueRef[];
    workflowRuns?: readonly WorkflowRunRef[];
    /** PR history (closed PRs included) — what `pullRequestHistory` returns. */
    pullRequestHistory?: readonly PullRequestHistoryRef[];
    /**
     * Repo files keyed `"owner/name:path"`, or `"owner/name@ref:path"` to pin a
     * ref; an unseeded path is `found: false`.
     */
    files?: Record<string, string>;
    /** Clock used to evaluate `pushedWithinDays` / `updatedWithinHours`. */
    now?: number;
    /**
     * Rows per page for `pullRequestHistory` — defaults to the live read's 100.
     * Lower it to make `maxPages` observable without seeding hundreds of PRs.
     */
    historyPageSize?: number;
  } = {},
): { layer: Layer.Layer<Github>; state: GithubFakeState } => {
  const state: GithubFakeState = {
    issues: [...(opts.issues ?? [])],
    workflowRuns: [...(opts.workflowRuns ?? [])],
    pullRequestHistory: [...(opts.pullRequestHistory ?? [])],
    files: { ...opts.files },
    issuesCalls: [],
    actionRunsCalls: [],
    pullRequestHistoryCalls: [],
    readTextFileCalls: [],
    pullReviewCalls: [],
    openDraftPullRequestCalls: [],
    createReleaseCalls: [],
    addIssueLabelsCalls: [],
    removeIssueLabelCalls: [],
    commentOnIssueCalls: [],
    assignIssueCalls: [],
    closeIssueAsDuplicateCalls: [],
  };
  const now = opts.now ?? NOW_DEFAULT;
  const pageSize = Math.max(1, opts.historyPageSize ?? HISTORY_PAGE_SIZE_DEFAULT);
  // Branches the fake has already "opened" a PR for — so a re-run with the same
  // headBranch reports `created: false`, mirroring the live idempotency.
  const openedBranches = new Set<string>();

  const service: GithubService = {
    issues: ({ repo, state: want = "open", labels, updatedWithinDays }) =>
      Effect.sync(() => {
        state.issuesCalls.push({ repo, state: want, labels, updatedWithinDays });
        const need = labels === undefined ? undefined : new Set(labels);
        return state.issues.filter((i) => {
          if (i.repo !== repo) return false;
          if (want !== "all" && i.state !== want) return false;
          if (need !== undefined && ![...need].every((l) => i.labels.includes(l))) return false;
          if (
            updatedWithinDays !== undefined &&
            i.updatedAt < now - updatedWithinDays * 86_400_000
          ) {
            return false;
          }
          return true;
        });
      }),

    // The writes record and mutate the seeded issue, so a test can assert both
    // "the call was made" and "the state machine advanced".
    addIssueLabels: ({ repo, issue, labels }) =>
      Effect.sync(() => {
        state.addIssueLabelsCalls.push({ repo, issue, labels });
        const target = state.issues.find((i) => i.repo === repo && i.number === issue);
        if (target !== undefined) {
          const merged = [...new Set([...target.labels, ...labels])];
          state.issues = state.issues.map((i) => (i === target ? { ...i, labels: merged } : i));
        }
      }),

    removeIssueLabel: ({ repo, issue, label }) =>
      Effect.sync(() => {
        state.removeIssueLabelCalls.push({ repo, issue, label });
        state.issues = state.issues.map((i) =>
          i.repo === repo && i.number === issue
            ? { ...i, labels: i.labels.filter((l) => l !== label) }
            : i,
        );
      }),

    commentOnIssue: ({ repo, issue, body }) =>
      Effect.sync(() => {
        state.commentOnIssueCalls.push({ repo, issue, body });
      }),

    assignIssue: ({ repo, issue, assignees }) =>
      Effect.sync(() => {
        state.assignIssueCalls.push({ repo, issue, assignees });
      }),

    closeIssueAsDuplicate: ({ repo, issue, duplicateOf }) =>
      Effect.sync(() => {
        state.closeIssueAsDuplicateCalls.push({ repo, issue, duplicateOf });
        state.issues = state.issues.map((i) =>
          i.repo === repo && i.number === issue ? { ...i, state: "closed" as const } : i,
        );
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
          if (conclusion !== undefined && r.conclusion !== conclusion) return false;
          if (createdWithinHours !== undefined) {
            const cutoff = now - createdWithinHours * 3_600_000;
            if (r.createdAt < cutoff) return false;
          }
          return true;
        });
      }),

    pullRequestHistory: ({
      repo,
      headBranchPrefix,
      state: prState = "all",
      updatedWithinDays,
      maxPages,
    }) =>
      Effect.sync(() => {
        state.pullRequestHistoryCalls.push({
          repo,
          headBranchPrefix,
          state: prState,
          updatedWithinDays,
          maxPages,
        });

        // Mirror the live read's server-side query — one repo, `state=` — and
        // its `sort=updated&direction=desc`. The order is the contract: it is
        // what makes `updatedWithinDays` a sound stopping rule rather than a
        // guess, so a fake returning seeded insertion order lets a caller that
        // depends on newest-first pass here and misbehave in production.
        const matching = state.pullRequestHistory
          .filter((pr) => pr.repo === repo && (prState === "all" || pr.state === prState))
          .sort((a, b) => b.updatedAt - a.updatedAt);

        const cutoff =
          updatedWithinDays === undefined ? undefined : now - updatedWithinDays * 86_400_000;

        // Walk pages the way the live read does, and stop where it stops: at the
        // page cap, on a short page, or once the oldest row collected predates
        // the cutoff. `updatedWithinDays` is a PAGINATION bound, not a filter —
        // live returns the out-of-window rows that share a page with in-window
        // ones, so the fake must too, or a caller that mishandles them is green
        // here and wrong in production.
        const collected: PullRequestHistoryRef[] = [];
        const pageCap = Math.max(1, maxPages ?? HISTORY_MAX_PAGES_DEFAULT);
        for (let page = 0; page < pageCap; page += 1) {
          const rows = matching.slice(page * pageSize, (page + 1) * pageSize);
          collected.push(...rows);
          if (rows.length < pageSize) break;
          const oldest = collected[collected.length - 1];
          if (cutoff !== undefined && oldest !== undefined && oldest.updatedAt < cutoff) break;
        }

        // GitHub's `head=` matches one exact branch, so the live read filters the
        // prefix client-side, after collection — it narrows what is returned,
        // never what is paginated.
        return headBranchPrefix === undefined || headBranchPrefix.length === 0
          ? collected
          : collected.filter((pr) => pr.headBranch.startsWith(headBranchPrefix));
      }),

    readTextFile: (req): Effect.Effect<TextFileResult, never> =>
      Effect.sync(() => {
        state.readTextFileCalls.push(req);
        // `ref` is part of the live read's identity — it goes into the URL — so a
        // fake that ignored it would answer every ref with the same bytes and
        // leave `ledgerRef` untested at any level. A ref-qualified key wins when
        // seeded; the bare key is the "any ref" fallback most tests want.
        const content =
          (req.ref === undefined ? undefined : state.files[`${req.repo}@${req.ref}:${req.path}`]) ??
          state.files[`${req.repo}:${req.path}`];
        return content === undefined ? { found: false } : { found: true, content };
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
