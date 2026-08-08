// @fractalboxdev/flare-dispatch-github-app — read a repo's PRs back, closed ones included.
//
// The read half of the PR surface. `commitFilesAndOpenPr` (pull-requests.ts)
// asks GitHub for `state=open` PRs on one exact head, because all it needs is
// "is my branch already open". A caller asking *"was this proposed before, and
// did a human close it unmerged, and when"* needs the opposite: every state, a
// head-branch **prefix** (each proposal carries its own dated branch), and
// `closed_at`.
//
// `closed_at` is the whole point. It is the only field that dates the decision;
// `updated_at` resets on any touch, so a cooldown computed from it never
// expires. It is also absent from the org context store's `pulls` table, which
// is why this read exists at all rather than a store query.
//
//   GET /repos/{owner}/{repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=N
//
// Authenticated with an installation access token (installation-token.ts) —
// never an App JWT, never a PAT. Provider-neutral plain `async`; the Effect
// Layer (`makeGithubLive`) wraps it and adds the rate-limit backoff.

import { assertOk, API_BASE_DEFAULT, ghHeaders, resolveClient, splitRepo } from "./http";

/** One PR as {@link listPullRequests} returns it — enough to date a decision. */
export type PullRequestSummary = {
  readonly number: number;
  readonly title: string;
  /** The PR body — where a proposal's `maintenance-key` lines live. */
  readonly body: string;
  /** The head branch name (no `owner:` prefix). */
  readonly headBranch: string;
  /** The head commit sha — what a CI run is matched against. */
  readonly headSha: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  /**
   * Label names on the PR. GitHub returns these on the LIST endpoint, unlike
   * the org context store's `pulls` table, which carries none — so a
   * `triage:*` state machine has to read them here.
   */
  readonly labels: readonly string[];
  /** The login that opened it — `""` when GitHub returned no user. */
  readonly author: string;
  /** Reviewers requested but not yet responded — empty means nobody is on it. */
  readonly requestedReviewers: readonly string[];
  readonly url: string;
  /** epoch ms. */
  readonly createdAt: number;
  /** epoch ms. */
  readonly updatedAt: number;
  /** epoch ms — `undefined` while the PR is open. */
  readonly closedAt?: number;
  /** epoch ms — `undefined` unless the PR was merged. */
  readonly mergedAt?: number;
};

export type ListPullRequestsOptions = {
  /** The installation access token authenticating the call. */
  readonly token: string;
  /** `"owner/repo"`. */
  readonly repo: string;
  /** `open` | `closed` | `all` — defaults to `all`. */
  readonly state?: "open" | "closed" | "all";
  /**
   * Keep only PRs whose head branch starts with this. Applied client-side —
   * GitHub's own `head=` filter matches one exact branch, not a prefix.
   */
  readonly headBranchPrefix?: string;
  /**
   * Stop paginating once a page's PRs were last updated before this cutoff
   * (epoch ms). Results are sorted by `updated` descending, so this is a safe
   * bound: `updated_at >= closed_at` always, so a PR closed after the cutoff
   * cannot sort below it. A **pagination** bound only — every date the caller
   * reasons about still comes from `closedAt`.
   */
  readonly updatedSince?: number;
  /** Page size (GitHub max 100). */
  readonly perPage?: number;
  /** Hard page cap so a huge repo cannot spin the Worker. Default 5. */
  readonly maxPages?: number;
  /** API base override (tests / GHE). */
  readonly apiBase?: string;
  /** `fetch` override — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

/** The subset of GitHub's `pulls[]` entry shape we consume. */
type RawPullRequest = {
  readonly number: number;
  readonly title?: string | null;
  readonly body?: string | null;
  readonly head?: { readonly ref?: string | null; readonly sha?: string | null } | null;
  readonly state?: string | null;
  readonly draft?: boolean | null;
  readonly labels?: readonly { readonly name?: string | null }[] | null;
  readonly user?: { readonly login?: string | null } | null;
  readonly requested_reviewers?: readonly { readonly login?: string | null }[] | null;
  readonly html_url?: string | null;
  readonly created_at?: string | null;
  readonly updated_at?: string | null;
  readonly closed_at?: string | null;
  readonly merged_at?: string | null;
};

/** Pluck a `login` / `name` list, dropping anything GitHub left null. */
const names = (
  raw:
    | readonly { readonly name?: string | null; readonly login?: string | null }[]
    | null
    | undefined,
): readonly string[] =>
  (raw ?? []).map((entry) => entry.name ?? entry.login ?? "").filter((name) => name.length > 0);

const PAGE_SIZE_DEFAULT = 100;
const MAX_PAGES_DEFAULT = 5;

/** Parse an ISO-8601 timestamp to epoch ms; `undefined` for null/garbage. */
const epochMs = (raw: string | null | undefined): number | undefined => {
  if (raw === null || raw === undefined) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
};

/** Build the `pulls` list URL for one page — pure, for unit testing. */
export const pullRequestsUrl = (opts: {
  readonly repo: string;
  readonly state?: "open" | "closed" | "all";
  readonly perPage?: number;
  readonly page?: number;
  readonly apiBase?: string;
}): string => {
  const { owner, name } = splitRepo(opts.repo);
  const base = opts.apiBase ?? API_BASE_DEFAULT;
  const params = new URLSearchParams({
    state: opts.state ?? "all",
    // `updated` desc is what makes `updatedSince` a sound stopping rule.
    sort: "updated",
    direction: "desc",
    per_page: String(opts.perPage ?? PAGE_SIZE_DEFAULT),
    page: String(opts.page ?? 1),
  });
  return `${base}/repos/${owner}/${name}/pulls?${params.toString()}`;
};

/** Normalize one raw GitHub PR into a {@link PullRequestSummary} — pure. */
export const normalizePullRequest = (repo: string, raw: RawPullRequest): PullRequestSummary => {
  const closedAt = epochMs(raw.closed_at);
  const mergedAt = epochMs(raw.merged_at);
  return {
    number: raw.number,
    title: raw.title ?? "",
    body: raw.body ?? "",
    headBranch: raw.head?.ref ?? "",
    headSha: raw.head?.sha ?? "",
    state: raw.state === "closed" ? "closed" : "open",
    draft: raw.draft ?? false,
    labels: names(raw.labels),
    author: raw.user?.login ?? "",
    requestedReviewers: names(raw.requested_reviewers),
    url: raw.html_url ?? `https://github.com/${repo}/pull/${raw.number}`,
    createdAt: epochMs(raw.created_at) ?? 0,
    updatedAt: epochMs(raw.updated_at) ?? 0,
    ...(closedAt !== undefined ? { closedAt } : {}),
    ...(mergedAt !== undefined ? { mergedAt } : {}),
  };
};

/**
 * List a repo's PRs, closed ones included, newest-touched first.
 *
 * Paginates up to `maxPages`, stopping early once a page runs past
 * `updatedSince` or comes back short.
 *
 * @throws {GithubApiError} when the API returns non-2xx.
 */
export const listPullRequests = async (
  opts: ListPullRequestsOptions,
): Promise<readonly PullRequestSummary[]> => {
  const { doFetch } = resolveClient(opts);
  const perPage = opts.perPage ?? PAGE_SIZE_DEFAULT;
  const maxPages = Math.max(1, opts.maxPages ?? MAX_PAGES_DEFAULT);
  const collected: PullRequestSummary[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const res = await doFetch(pullRequestsUrl({ ...opts, perPage, page }), {
      method: "GET",
      headers: ghHeaders(opts.token),
    });
    await assertOk(res, `pull request list failed for ${opts.repo}`);
    const body = (await res.json()) as RawPullRequest[];
    const raw = Array.isArray(body) ? body : [];
    collected.push(...raw.map((p) => normalizePullRequest(opts.repo, p)));

    // A short page is the last page.
    if (raw.length < perPage) break;
    // Sorted by `updated` desc — once the page's oldest entry predates the
    // cutoff, every later page does too.
    const oldest = collected[collected.length - 1];
    if (
      opts.updatedSince !== undefined &&
      oldest !== undefined &&
      oldest.updatedAt < opts.updatedSince
    ) {
      break;
    }
  }

  const prefix = opts.headBranchPrefix;
  return prefix === undefined || prefix.length === 0
    ? collected
    : collected.filter((pr) => pr.headBranch.startsWith(prefix));
};
