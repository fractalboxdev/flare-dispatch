// @fractalboxdev/flare-dispatch-github-app — commit file edits + open/update a PR (Git Data API).
//
// `commitFilesAndOpenPr` commits a set of file edits (writes AND deletions, with
// per-file modes) and opens/updates a PR — all from the Worker via the Git Data
// API, with NO container `git push`:
//
//   1. resolve the base branch (default branch when unspecified) + its tip;
//   2. create a blob per written file, then a tree on top of the base commit's
//      tree — a deletion is a tree entry with `sha: null`;
//   3. create a commit, then create-or-force-update `refs/heads/<headBranch>`;
//   4. find an open PR for the head branch, else open a new PR (draft per opt).
//
// Idempotent on `headBranch`: a re-run updates the branch (force-update to the
// fresh commit) and reuses the already-open PR. With `preserveHumanCommits`, a
// branch carrying any commit not authored by a bot account is left untouched,
// so a reviewer's push to a rolling PR survives the next run. Used by both the `github`
// capability's `openDraftPullRequest` (run-driven, full-content edits) and the
// Worker's post-run `writeback` step (manifest-driven, supports deletions +
// modes + non-draft).
//
// Authenticated with an installation access token — never an App JWT, never a
// PAT. Provider-neutral plain `async`; the Effect Layer (`makeGithubLive`)
// wraps it.

import { assertOk, ghHeaders, resolveClient, splitRepo } from "./http";

/** A file edit — full new content keyed by repo-relative path, plus mode. */
export type FileEdit = {
  readonly path: string;
  readonly content: string;
  /** Blob mode — `"100644"` (default) or `"100755"` (executable). */
  readonly mode?: "100644" | "100755";
};

/** A file deletion — drop `path` from the tree. */
export type FileDeletion = { readonly path: string };

/** A git tree entry — a blob (write) or a `sha: null` (deletion). */
export type TreeEntry =
  | { path: string; mode: "100644" | "100755"; type: "blob"; sha: string }
  | { path: string; mode: "100644"; type: "blob"; sha: null };

export type CommitFilesOptions = {
  /** The installation access token authenticating the writes. */
  readonly token: string;
  /** `"owner/repo"`. */
  readonly repo: string;
  /** Base branch — defaults to the repo's default branch. */
  readonly baseBranch?: string;
  /** Head branch to create/update. */
  readonly headBranch: string;
  /** Commit message for the edits. */
  readonly commitMessage: string;
  /** Files to write (full new contents). */
  readonly files: readonly FileEdit[];
  /** Files to delete. */
  readonly deletions?: readonly FileDeletion[];
  /**
   * When the head branch already exists, force-update it (default `true`). When
   * `false`, an existing ref is left untouched and `updated: false` is returned
   * with no commit — the caller's "no-op on existing branch" path.
   */
  readonly updateExisting?: boolean;
  /**
   * Leave the head branch untouched (`skipped: true`, no commit) when it
   * carries any commit ahead of the base that a bot account did not author —
   * a human pushed to it, and a force-update would discard that work.
   * Default `false`.
   */
  readonly preserveHumanCommits?: boolean;
  /** Open a PR. `false` ⇒ push the branch only, open no PR. */
  readonly pr: { readonly title: string; readonly body: string; readonly draft?: boolean } | false;
  /** API base override (tests / GHE). */
  readonly apiBase?: string;
  /** `fetch` override — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

export type CommitFilesResult = {
  /** The PR number, or `undefined` when `pr: false` (branch-only). */
  readonly number?: number;
  /** The PR's web URL, or `undefined` when `pr: false`. */
  readonly url?: string;
  /** The commit sha that landed, or `undefined` when a no-op (see below). */
  readonly commitSha?: string;
  /** `true` when a new PR was opened; `false` when an existing one was reused
   * or `pr: false`. */
  readonly created: boolean;
  /**
   * `true` when nothing was written: the head branch already existed and
   * `updateExisting: false`, or it carries human commits and
   * `preserveHumanCommits` is set. The caller reports a clean skip.
   */
  readonly skipped: boolean;
};

/** Build a non-executable blob tree entry for a file write — pure. */
export const treeEntry = (
  path: string,
  sha: string,
  mode: "100644" | "100755" = "100644",
): TreeEntry => ({ path, mode, type: "blob", sha });

/** Build a deletion tree entry (`sha: null`) — pure. */
export const deletionEntry = (path: string): TreeEntry => ({
  path,
  mode: "100644",
  type: "blob",
  sha: null,
});

type RepoApi = <T>(
  path: string,
  init?: { method?: string; body?: unknown },
  okExtra?: (status: number) => boolean,
) => Promise<{ status: number; json: T }>;

/** A bound JSON client for one repo's REST endpoints. */
const repoApi = (opts: {
  token: string;
  repo: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}): { api: RepoApi; owner: string } => {
  const { owner, name } = splitRepo(opts.repo);
  const { apiBase, doFetch } = resolveClient(opts);
  const repoUrl = `${apiBase}/repos/${owner}/${name}`;
  const api: RepoApi = async <T>(
    path: string,
    init?: { method?: string; body?: unknown },
    okExtra?: (status: number) => boolean,
  ) => {
    const res = await doFetch(`${repoUrl}${path}`, {
      method: init?.method ?? "GET",
      headers: ghHeaders(opts.token, { json: true }),
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!(okExtra?.(res.status) ?? false)) {
      await assertOk(res, `git data call ${init?.method ?? "GET"} ${path} failed`);
    }
    const json = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, json };
  };
  return { api, owner };
};

/**
 * Whether `headBranch` carries a commit ahead of `baseBranch` that no bot
 * account authored. A commit whose author email maps to no GitHub account has
 * no `author` object and counts as human. A missing head branch has no
 * commits, so the answer is `false`.
 */
const hasHumanCommits = async (
  api: RepoApi,
  baseBranch: string,
  headBranch: string,
): Promise<boolean> => {
  const compare = await api<{ commits?: Array<{ author: { type?: string } | null }> }>(
    `/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(headBranch)}`,
    undefined,
    (status) => status === 404,
  );
  if (compare.status === 404) return false;
  return (compare.json.commits ?? []).some((c) => c.author?.type !== "Bot");
};

/**
 * Commit the file edits + deletions and open (or update) a PR.
 *
 * @throws {GithubApiError} when any underlying call returns non-2xx (other than
 * the expected 422 on an already-existing ref, which is handled per
 * `updateExisting`).
 */
export const commitFilesAndOpenPr = async (
  opts: CommitFilesOptions,
): Promise<CommitFilesResult> => {
  const { api, owner } = repoApi(opts);
  const updateExisting = opts.updateExisting ?? true;

  // 1. Base branch + its tip commit.
  const baseBranch =
    opts.baseBranch ?? (await api<{ default_branch: string }>("")).json.default_branch;

  // If the head ref already exists and we won't update it, this is a no-op.
  // A 404 on the head ref means "fresh branch" → proceed to create it.
  if (!updateExisting) {
    const headRef = await api<unknown>(
      `/git/ref/heads/${encodeURIComponent(opts.headBranch)}`,
      undefined,
      (status) => status === 404,
    );
    if (headRef.status !== 404) {
      return { created: false, skipped: true };
    }
  }

  if (
    opts.preserveHumanCommits === true &&
    (await hasHumanCommits(api, baseBranch, opts.headBranch))
  ) {
    return { created: false, skipped: true };
  }

  const baseRef = (
    await api<{ object: { sha: string } }>(`/git/ref/heads/${encodeURIComponent(baseBranch)}`)
  ).json.object.sha;

  const baseTreeSha = (await api<{ tree: { sha: string } }>(`/git/commits/${baseRef}`)).json.tree
    .sha;

  // 2. A blob per written file → tree entries; deletions are `sha: null` entries.
  const writeEntries = await Promise.all(
    opts.files.map(async (f) => {
      const blob = await api<{ sha: string }>("/git/blobs", {
        method: "POST",
        body: { content: f.content, encoding: "utf-8" },
      });
      return treeEntry(f.path, blob.json.sha, f.mode ?? "100644");
    }),
  );
  const deleteEntries = (opts.deletions ?? []).map((d) => deletionEntry(d.path));
  const tree: TreeEntry[] = [...writeEntries, ...deleteEntries];

  const newTree = (
    await api<{ sha: string }>("/git/trees", {
      method: "POST",
      body: { base_tree: baseTreeSha, tree },
    })
  ).json.sha;

  // 3. Commit, then create-or-force-update the head ref.
  const commitSha = (
    await api<{ sha: string }>("/git/commits", {
      method: "POST",
      body: { message: opts.commitMessage, tree: newTree, parents: [baseRef] },
    })
  ).json.sha;

  const created = await api<unknown>(
    "/git/refs",
    {
      method: "POST",
      body: { ref: `refs/heads/${opts.headBranch}`, sha: commitSha },
    },
    // 422 → the ref already exists; fall through to a force-update.
    (status) => status === 422,
  );
  if (created.status === 422) {
    await api("/git/refs/heads/" + encodeURIComponent(opts.headBranch), {
      method: "PATCH",
      body: { sha: commitSha, force: true },
    });
  }

  // `pr: false` — push the branch only.
  if (opts.pr === false) {
    return { commitSha, created: false, skipped: false };
  }

  // 4. Reuse an open PR for this head, else open a new one.
  const existing = (
    await api<Array<{ number: number; html_url: string }>>(
      `/pulls?head=${owner}:${encodeURIComponent(opts.headBranch)}&state=open`,
    )
  ).json;
  if (Array.isArray(existing) && existing.length > 0) {
    const pr = existing[0]!;
    // Refresh title/body so a re-run keeps the PR current.
    await api(`/pulls/${pr.number}`, {
      method: "PATCH",
      body: { title: opts.pr.title, body: opts.pr.body },
    });
    return {
      number: pr.number,
      url: pr.html_url,
      commitSha,
      created: false,
      skipped: false,
    };
  }

  const opened = (
    await api<{ number: number; html_url: string }>("/pulls", {
      method: "POST",
      body: {
        title: opts.pr.title,
        head: opts.headBranch,
        base: baseBranch,
        body: opts.pr.body,
        draft: opts.pr.draft ?? true,
      },
    })
  ).json;
  return {
    number: opened.number,
    url: opened.html_url,
    commitSha,
    created: true,
    skipped: false,
  };
};

// --- Back-compat: openDraftPullRequest --------------------------------------
//
// The `github` capability's run-driven `openDraftPullRequest` (full-content
// edits, always-draft PR) is a thin wrapper over `commitFilesAndOpenPr`. The
// `spec-drift` / `ci-triage` recipes call it through the capability.

export type OpenDraftPullRequestOptions = {
  readonly token: string;
  readonly repo: string;
  readonly baseBranch?: string;
  readonly headBranch: string;
  readonly title: string;
  readonly body: string;
  readonly commitMessage: string;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  /** Open as a draft. Default `true`. */
  readonly draft?: boolean;
  /** See {@link CommitFilesOptions.preserveHumanCommits}. */
  readonly preserveHumanCommits?: boolean;
  readonly apiBase?: string;
  readonly fetchImpl?: typeof fetch;
};

export type OpenDraftPullRequestResult = {
  readonly number: number;
  readonly url: string;
  readonly created: boolean;
  /** `true` when human commits on the head branch left it untouched. */
  readonly skipped: boolean;
};

/** Commit the file edits and open (or update) a PR (draft by default). */
export const openDraftPullRequest = async (
  opts: OpenDraftPullRequestOptions,
): Promise<OpenDraftPullRequestResult> => {
  const result = await commitFilesAndOpenPr({
    token: opts.token,
    repo: opts.repo,
    ...(opts.baseBranch !== undefined ? { baseBranch: opts.baseBranch } : {}),
    headBranch: opts.headBranch,
    commitMessage: opts.commitMessage,
    files: opts.files,
    pr: { title: opts.title, body: opts.body, draft: opts.draft ?? true },
    ...(opts.preserveHumanCommits !== undefined
      ? { preserveHumanCommits: opts.preserveHumanCommits }
      : {}),
    ...(opts.apiBase !== undefined ? { apiBase: opts.apiBase } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return {
    number: result.number ?? 0,
    url: result.url ?? "",
    created: result.created,
    skipped: result.skipped,
  };
};

// --- closeBotPullRequest ------------------------------------------------------
//
// The retraction a rolling-PR run needs when a fire finds nothing to propose:
// the open PR still carries yesterday's full-file contents, and merging it
// would revert whatever fixed the drift on the base branch.

export type CloseBotPullRequestOptions = {
  readonly token: string;
  readonly repo: string;
  /** The head branch whose open PR to close. */
  readonly headBranch: string;
  /** Comment posted on the PR before it closes. */
  readonly comment: string;
  readonly apiBase?: string;
  readonly fetchImpl?: typeof fetch;
};

export type CloseBotPullRequestResult =
  | { readonly closed: true; readonly number: number }
  | {
      readonly closed: false;
      readonly reason: "none-open" | "human-owned";
      readonly number?: number;
    };

/**
 * Close the open PR on `headBranch` — only when a bot account opened it and
 * every commit on the branch is bot-authored. A PR a human opened or pushed to
 * stays open (`reason: "human-owned"`); the branch itself is kept, so the next
 * proposal force-updates it and opens a fresh PR.
 */
export const closeBotPullRequest = async (
  opts: CloseBotPullRequestOptions,
): Promise<CloseBotPullRequestResult> => {
  const { api, owner } = repoApi(opts);
  const open = (
    await api<Array<{ number: number; user: { type?: string } | null; base: { ref: string } }>>(
      `/pulls?head=${owner}:${encodeURIComponent(opts.headBranch)}&state=open`,
    )
  ).json;
  const pr = Array.isArray(open) ? open[0] : undefined;
  if (pr === undefined) return { closed: false, reason: "none-open" };

  if (pr.user?.type !== "Bot" || (await hasHumanCommits(api, pr.base.ref, opts.headBranch))) {
    return { closed: false, reason: "human-owned", number: pr.number };
  }

  await api(`/issues/${pr.number}/comments`, { method: "POST", body: { body: opts.comment } });
  await api(`/pulls/${pr.number}`, { method: "PATCH", body: { state: "closed" } });
  return { closed: true, number: pr.number };
};
