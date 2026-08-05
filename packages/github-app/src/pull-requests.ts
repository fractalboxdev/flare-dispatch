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
// fresh commit) and reuses the already-open PR. Used by both the `github`
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
   * `updateExisting: false`. The caller reports a clean skip.
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
  const { owner, name } = splitRepo(opts.repo);
  const { apiBase, doFetch } = resolveClient(opts);
  const repoUrl = `${apiBase}/repos/${owner}/${name}`;
  const updateExisting = opts.updateExisting ?? true;

  const api = async <T>(
    path: string,
    init?: { method?: string; body?: unknown },
    okExtra?: (status: number) => boolean,
  ): Promise<{ status: number; json: T }> => {
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
  readonly apiBase?: string;
  readonly fetchImpl?: typeof fetch;
};

export type OpenDraftPullRequestResult = {
  readonly number: number;
  readonly url: string;
  readonly created: boolean;
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
    ...(opts.apiBase !== undefined ? { apiBase: opts.apiBase } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return {
    number: result.number ?? 0,
    url: result.url ?? "",
    created: result.created,
  };
};
