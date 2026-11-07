// The GitHub calls the `pr.propose` and `pr.close` appliers make: the Git Data API for blobs, trees, commits and refs,
// and the pulls API. Only the control plane holds the installation token these calls carry (FD-AGT-008).
import { Context, Effect, Layer, Schema } from "effect";

export class GitDataError extends Schema.TaggedError<GitDataError>()("GitDataError", {
  call: Schema.String,
  /** The HTTP status, or 0 when no response arrived. */
  status: Schema.Number,
  detail: Schema.String,
}) {}

export interface Repo {
  readonly scopeId: string;
  readonly owner: string;
  readonly name: string;
}

export interface BranchCommit {
  readonly sha: string;
  readonly message: string;
  /** The commit author's GitHub login, or null when GitHub maps the author to no account. */
  readonly authorLogin: string | null;
}

export interface PullRef {
  readonly number: number;
  readonly url: string;
  readonly head: string;
}

export interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly sha: string;
}

export class GitData extends Context.Service<
  GitData,
  {
    readonly defaultBranch: (repo: Repo) => Effect.Effect<string, GitDataError>;
    readonly branchProtected: (repo: Repo, branch: string) => Effect.Effect<boolean, GitDataError>;
    /** The branch head's sha, or null when the branch does not exist. */
    readonly refSha: (repo: Repo, branch: string) => Effect.Effect<string | null, GitDataError>;
    /** The commits reachable from `head` and not from `base`, newest first. */
    readonly commitsSince: (
      repo: Repo,
      base: string,
      head: string,
    ) => Effect.Effect<readonly BranchCommit[], GitDataError>;
    readonly commit: (
      repo: Repo,
      sha: string,
    ) => Effect.Effect<BranchCommit & { readonly tree: string }, GitDataError>;
    /** A file's bytes at a commit, or null when the path does not exist there. */
    readonly fileAt: (
      repo: Repo,
      commit: string,
      path: string,
    ) => Effect.Effect<Uint8Array | null, GitDataError>;
    readonly createBlob: (repo: Repo, bytes: Uint8Array) => Effect.Effect<string, GitDataError>;
    readonly createTree: (
      repo: Repo,
      baseTree: string,
      entries: readonly TreeEntry[],
    ) => Effect.Effect<string, GitDataError>;
    readonly createCommit: (
      repo: Repo,
      input: {
        readonly message: string;
        readonly tree: string;
        readonly parents: readonly string[];
      },
    ) => Effect.Effect<string, GitDataError>;
    readonly createRef: (
      repo: Repo,
      branch: string,
      sha: string,
    ) => Effect.Effect<void, GitDataError>;
    readonly updateRef: (
      repo: Repo,
      branch: string,
      sha: string,
    ) => Effect.Effect<void, GitDataError>;
    readonly openPull: (repo: Repo, head: string) => Effect.Effect<PullRef | null, GitDataError>;
    readonly createPull: (
      repo: Repo,
      input: {
        readonly head: string;
        readonly base: string;
        readonly title: string;
        readonly body: string;
        readonly draft: boolean;
      },
    ) => Effect.Effect<PullRef, GitDataError>;
    readonly updatePull: (
      repo: Repo,
      number: number,
      input: { readonly title: string; readonly body: string },
    ) => Effect.Effect<void, GitDataError>;
    readonly addLabels: (
      repo: Repo,
      number: number,
      labels: readonly string[],
    ) => Effect.Effect<void, GitDataError>;
    readonly closePull: (repo: Repo, number: number) => Effect.Effect<void, GitDataError>;
  }
>()("@fractalboxdev/flare-dispatch-agentic/GitData") {}

export interface GitDataOptions {
  readonly apiBase?: string;
  /** The installation token for a tenant scope, minted in the control plane. */
  readonly token: (scopeId: string) => Effect.Effect<string, GitDataError>;
  readonly fetch: typeof globalThis.fetch;
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

const fromBase64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text.replace(/\s/g, "")), (c) => c.charCodeAt(0));

/** The `GitData` service over GitHub's REST API with the installation token of the row's tenant scope. */
export const gitDataLayer = (options: GitDataOptions): Layer.Layer<GitData> => {
  const base = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const call = <T>(
    repo: Repo,
    name: string,
    method: string,
    path: string,
    body?: unknown,
    allow404 = false,
  ): Effect.Effect<T | null, GitDataError> =>
    Effect.gen(function* () {
      const token = yield* options.token(repo.scopeId);
      const response = yield* Effect.tryPromise({
        try: () =>
          options.fetch(`${base}/repos/${repo.owner}/${repo.name}${path}`, {
            method,
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${token}`,
              "x-github-api-version": "2022-11-28",
              "user-agent": "flare-dispatch",
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        catch: (cause) => new GitDataError({ call: name, status: 0, detail: String(cause) }),
      });
      if (allow404 && response.status === 404) return null;
      if (!response.ok) {
        const text = yield* Effect.promise(() => response.text().catch(() => ""));
        return yield* new GitDataError({
          call: name,
          status: response.status,
          detail: text.slice(0, 300),
        });
      }
      if (response.status === 204) return null;
      return (yield* Effect.tryPromise({
        try: () => response.json() as Promise<T>,
        catch: (cause) =>
          new GitDataError({ call: name, status: response.status, detail: String(cause) }),
      })) as T;
    });
  const must = <T>(effect: Effect.Effect<T | null, GitDataError>, name: string) =>
    Effect.flatMap(effect, (v) =>
      v === null
        ? Effect.fail(new GitDataError({ call: name, status: 0, detail: "empty response" }))
        : Effect.succeed(v),
    );
  const ref = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");
  const commitOf = (c: {
    sha: string;
    commit: { message: string; tree?: { sha: string } };
    author: { login: string } | null;
  }) => ({ sha: c.sha, message: c.commit.message, authorLogin: c.author?.login ?? null });

  return Layer.succeed(GitData, {
    defaultBranch: (repo) =>
      Effect.map(
        must(call<{ default_branch: string }>(repo, "repo", "GET", ""), "repo"),
        (r) => r.default_branch,
      ),
    branchProtected: (repo, branch) =>
      Effect.map(
        call<{ protected: boolean }>(
          repo,
          "branch",
          "GET",
          `/branches/${ref(branch)}`,
          undefined,
          true,
        ),
        (b) => b?.protected ?? false,
      ),
    refSha: (repo, branch) =>
      Effect.map(
        call<{ object: { sha: string } }>(
          repo,
          "ref",
          "GET",
          `/git/ref/heads/${ref(branch)}`,
          undefined,
          true,
        ),
        (r) => r?.object.sha ?? null,
      ),
    commitsSince: (repo, baseSha, head) =>
      Effect.map(
        must(
          call<{ commits: Parameters<typeof commitOf>[0][] }>(
            repo,
            "compare",
            "GET",
            `/compare/${baseSha}...${head}`,
          ),
          "compare",
        ),
        (r) => r.commits.map(commitOf).reverse(),
      ),
    commit: (repo, sha) =>
      Effect.map(
        must(
          call<Parameters<typeof commitOf>[0] & { commit: { tree: { sha: string } } }>(
            repo,
            "commit",
            "GET",
            `/commits/${sha}`,
          ),
          "commit",
        ),
        (c) => ({ ...commitOf(c), tree: c.commit.tree.sha }),
      ),
    fileAt: (repo, commit, path) =>
      Effect.map(
        call<{ content?: string; encoding?: string; type?: string }>(
          repo,
          "contents",
          "GET",
          `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${commit}`,
          undefined,
          true,
        ),
        (f) =>
          f === null || f.type !== "file" || f.content === undefined ? null : fromBase64(f.content),
      ),
    createBlob: (repo, bytes) =>
      Effect.map(
        must(
          call<{ sha: string }>(repo, "blob", "POST", "/git/blobs", {
            content: toBase64(bytes),
            encoding: "base64",
          }),
          "blob",
        ),
        (b) => b.sha,
      ),
    createTree: (repo, baseTree, entries) =>
      Effect.map(
        must(
          call<{ sha: string }>(repo, "tree", "POST", "/git/trees", {
            base_tree: baseTree,
            tree: entries.map((e) => ({ path: e.path, mode: e.mode, type: "blob", sha: e.sha })),
          }),
          "tree",
        ),
        (t) => t.sha,
      ),
    createCommit: (repo, input) =>
      Effect.map(
        must(call<{ sha: string }>(repo, "commit", "POST", "/git/commits", input), "commit"),
        (c) => c.sha,
      ),
    createRef: (repo, branch, sha) =>
      Effect.asVoid(call(repo, "ref", "POST", "/git/refs", { ref: `refs/heads/${branch}`, sha })),
    updateRef: (repo, branch, sha) =>
      Effect.asVoid(
        call(repo, "ref", "PATCH", `/git/refs/heads/${ref(branch)}`, { sha, force: true }),
      ),
    openPull: (repo, head) =>
      Effect.map(
        must(
          call<{ number: number; html_url: string; head: { ref: string } }[]>(
            repo,
            "pulls",
            "GET",
            `/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${head}`)}`,
          ),
          "pulls",
        ),
        (pulls) => {
          const p = pulls[0];
          return p === undefined ? null : { number: p.number, url: p.html_url, head: p.head.ref };
        },
      ),
    createPull: (repo, input) =>
      Effect.map(
        must(
          call<{ number: number; html_url: string }>(repo, "pull", "POST", "/pulls", input),
          "pull",
        ),
        (p) => ({ number: p.number, url: p.html_url, head: input.head }),
      ),
    updatePull: (repo, number, input) =>
      Effect.asVoid(call(repo, "pull", "PATCH", `/pulls/${number}`, input)),
    addLabels: (repo, number, labels) =>
      labels.length === 0
        ? Effect.void
        : Effect.asVoid(call(repo, "labels", "POST", `/issues/${number}/labels`, { labels })),
    closePull: (repo, number) =>
      Effect.asVoid(call(repo, "pull", "PATCH", `/pulls/${number}`, { state: "closed" })),
  });
};
