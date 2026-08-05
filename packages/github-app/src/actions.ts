// @fractalboxdev/flare-dispatch-github-app — GitHub Actions workflow-run read.
//
// `listActionRuns` reads a repo's recent workflow runs:
//   GET /repos/{owner}/{repo}/actions/runs?status={status}&per_page={n}
//
// The `ci-triage` recipe scans these for failures across the repos the App is
// installed on. Authenticated with an installation access token
// (installation-token.ts) — never an App JWT, never a PAT. Provider-neutral
// plain `async`; the Effect Layer (`makeGithubLive` in @fractalboxdev/flare-dispatch-runtime-cf)
// wraps it.

import { assertOk, API_BASE_DEFAULT, ghHeaders, resolveClient, splitRepo } from "./http";

/** One workflow run, normalized from GitHub's `actions/runs` payload. */
export type ActionRun = {
  readonly id: number;
  readonly name: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string;
  readonly url: string;
  readonly createdAt: number;
};

export type ListActionRunsOptions = {
  /** The installation access token authenticating the call. */
  readonly token: string;
  /** `"owner/repo"`. */
  readonly repo: string;
  /** GitHub run status filter — defaults to `completed`. */
  readonly status?: string;
  /** Page size (GitHub max 100). */
  readonly perPage?: number;
  /** API base override (tests / GHE). */
  readonly apiBase?: string;
  /** `fetch` override — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

/** The subset of GitHub's `workflow_runs[]` entry shape we consume. */
type RawWorkflowRun = {
  readonly id: number;
  readonly name?: string | null;
  readonly head_branch?: string | null;
  readonly head_sha?: string | null;
  readonly status?: string | null;
  readonly conclusion?: string | null;
  readonly html_url?: string | null;
  readonly created_at?: string | null;
};

/** Build the `actions/runs` request URL — pure, for unit testing. */
export const actionRunsUrl = (opts: {
  readonly repo: string;
  readonly status?: string;
  readonly perPage?: number;
  readonly apiBase?: string;
}): string => {
  const { owner, name } = splitRepo(opts.repo);
  const base = opts.apiBase ?? API_BASE_DEFAULT;
  const params = new URLSearchParams({
    status: opts.status ?? "completed",
    per_page: String(opts.perPage ?? 30),
  });
  return `${base}/repos/${owner}/${name}/actions/runs?${params.toString()}`;
};

/** Normalize one raw GitHub run into an {@link ActionRun} — pure. */
export const normalizeRun = (repo: string, raw: RawWorkflowRun): ActionRun => {
  const createdMs = raw.created_at ? Date.parse(raw.created_at) : Number.NaN;
  return {
    id: raw.id,
    name: raw.name ?? "",
    headBranch: raw.head_branch ?? "",
    headSha: raw.head_sha ?? "",
    status: raw.status ?? "",
    conclusion: raw.conclusion ?? "",
    url: raw.html_url ?? `https://github.com/${repo}/actions/runs/${raw.id}`,
    createdAt: Number.isNaN(createdMs) ? 0 : createdMs,
  };
};

/**
 * List a repo's recent workflow runs (one page).
 *
 * @throws {GithubApiError} when the API returns non-2xx.
 */
export const listActionRuns = async (
  opts: ListActionRunsOptions,
): Promise<readonly ActionRun[]> => {
  const { doFetch } = resolveClient(opts);
  const res = await doFetch(actionRunsUrl(opts), {
    method: "GET",
    headers: ghHeaders(opts.token),
  });
  await assertOk(res, `actions runs list failed for ${opts.repo}`);
  const body = (await res.json()) as { workflow_runs?: RawWorkflowRun[] };
  return (body.workflow_runs ?? []).map((r) => normalizeRun(opts.repo, r));
};
