// The GitHub REST calls the side-output appliers make: comments, reviews,
// issues, labels, the Git Data API and pull requests, releases and their assets.
// Every call runs under the installation token and reports its rate-limit
// headers to the installation quota through `restRequest`.
import { Clock, Context, Effect, Layer } from "effect";
import {
  GithubHttpError,
  GithubNetworkError,
  observeHeaders,
  restRequest,
  type GithubClientOptions,
  type GithubError,
} from "./client.ts";
import { InstallationQuota } from "./rate-limit.ts";

export interface Commented {
  readonly id: number;
  readonly body: string | null;
  /** The account that wrote it, as GitHub's REST response reports it. */
  readonly user?: { readonly login: string } | null;
}
export interface IssueRef {
  readonly id: number;
  readonly number: number;
  readonly body: string | null;
  readonly pull_request?: unknown;
}
export interface BranchHead {
  readonly sha: string;
  readonly protected: boolean;
}
export interface GitCommit {
  readonly sha: string;
  readonly message: string;
  readonly tree: { readonly sha: string };
}
/** A commit's author as GitHub reports it: the account login when it maps to one, and the git author email. */
export interface CommitAuthor {
  readonly sha: string;
  readonly login: string | null;
  readonly email: string | null;
}
export interface PullRef {
  readonly id: number;
  readonly number: number;
  readonly state: "open" | "closed";
  readonly draft?: boolean;
  readonly head: { readonly ref: string; readonly sha: string };
  readonly base: { readonly ref: string };
}
export interface Release {
  readonly id: number;
  readonly tag_name: string;
  readonly draft: boolean;
  readonly assets: readonly { readonly name: string }[];
}
export interface TreeEntry {
  readonly path: string;
  readonly mode: "100644" | "100755";
  readonly sha: string;
}

interface Repo {
  readonly installation: number;
  readonly repo: string;
}

export class GithubWrites extends Context.Service<
  GithubWrites,
  {
    readonly listComments: (
      c: Repo & { readonly issue: number },
    ) => Effect.Effect<readonly Commented[], GithubError>;
    readonly createComment: (
      c: Repo & { readonly issue: number; readonly body: string },
    ) => Effect.Effect<Commented, GithubError>;
    /** Replaces the body of an issue or pull-request comment. */
    readonly updateComment: (
      c: Repo & { readonly comment: number; readonly body: string },
    ) => Effect.Effect<Commented, GithubError>;
    readonly listReviews: (
      c: Repo & { readonly pull: number },
    ) => Effect.Effect<readonly Commented[], GithubError>;
    readonly createReview: (
      c: Repo & { readonly pull: number; readonly body: string; readonly commitId?: string },
    ) => Effect.Effect<Commented, GithubError>;
    /** One page of 100 of the repository's issues and pull requests, newest first; page 1 is the first. */
    readonly issuesPage: (
      c: Repo & { readonly page: number },
    ) => Effect.Effect<readonly IssueRef[], GithubError>;
    readonly createIssue: (
      c: Repo & {
        readonly title: string;
        readonly body: string;
        readonly labels: readonly string[];
      },
    ) => Effect.Effect<IssueRef, GithubError>;
    readonly updateIssue: (
      c: Repo & { readonly issue: number; readonly title: string; readonly body: string },
    ) => Effect.Effect<IssueRef, GithubError>;
    readonly addLabels: (
      c: Repo & { readonly issue: number; readonly labels: readonly string[] },
    ) => Effect.Effect<void, GithubError>;
    /** Removing a label the issue does not carry is not an error. */
    readonly removeLabel: (
      c: Repo & { readonly issue: number; readonly label: string },
    ) => Effect.Effect<void, GithubError>;
    /** The branch's head and protection, or null when the branch does not exist. */
    readonly branch: (
      c: Repo & { readonly branch: string },
    ) => Effect.Effect<BranchHead | null, GithubError>;
    readonly commit: (c: Repo & { readonly sha: string }) => Effect.Effect<GitCommit, GithubError>;
    /** The authors of the commits on `head` that `base` does not reach. */
    readonly commitsBetween: (
      c: Repo & { readonly base: string; readonly head: string },
    ) => Effect.Effect<readonly CommitAuthor[], GithubError>;
    readonly createBlob: (
      c: Repo & { readonly base64: string },
    ) => Effect.Effect<{ readonly sha: string }, GithubError>;
    readonly createTree: (
      c: Repo & { readonly baseTree: string; readonly entries: readonly TreeEntry[] },
    ) => Effect.Effect<{ readonly sha: string }, GithubError>;
    readonly createCommit: (
      c: Repo & {
        readonly message: string;
        readonly tree: string;
        readonly parents: readonly string[];
        readonly author: { readonly name: string; readonly email: string };
      },
    ) => Effect.Effect<{ readonly sha: string }, GithubError>;
    /** Creates `refs/heads/<branch>` at `sha`, or moves it there when it exists. */
    readonly setBranch: (
      c: Repo & { readonly branch: string; readonly sha: string; readonly exists: boolean },
    ) => Effect.Effect<void, GithubError>;
    readonly openPulls: (
      c: Repo & { readonly head: string },
    ) => Effect.Effect<readonly PullRef[], GithubError>;
    readonly pull: (c: Repo & { readonly pull: number }) => Effect.Effect<PullRef, GithubError>;
    readonly pullCommits: (
      c: Repo & { readonly pull: number },
    ) => Effect.Effect<readonly CommitAuthor[], GithubError>;
    readonly createPull: (
      c: Repo & {
        readonly title: string;
        readonly body: string;
        readonly head: string;
        readonly base: string;
        readonly draft: boolean;
      },
    ) => Effect.Effect<PullRef, GithubError>;
    readonly closePull: (
      c: Repo & { readonly pull: number },
    ) => Effect.Effect<PullRef, GithubError>;
    /** Every release, drafts included, at most 100; GitHub's by-tag read omits drafts. */
    readonly releases: (c: Repo) => Effect.Effect<readonly Release[], GithubError>;
    readonly createDraftRelease: (
      c: Repo & {
        readonly tag: string;
        readonly target: string;
        readonly name: string;
        readonly body: string;
      },
    ) => Effect.Effect<Release, GithubError>;
    readonly publishRelease: (
      c: Repo & { readonly release: number },
    ) => Effect.Effect<Release, GithubError>;
    readonly uploadAsset: (
      c: Repo & {
        readonly release: number;
        readonly name: string;
        readonly contentType: string;
        readonly bytes: Uint8Array;
      },
    ) => Effect.Effect<void, GithubError>;
    /** Mints a new installation token, for the one retry after a `401` (FD-GH-047). */
    readonly refreshToken: (installation: number) => Effect.Effect<void, GithubError>;
  }
>()("@fractalboxdev/flare-dispatch-github/GithubWrites") {}

const notFoundAsNull = <A>(effect: Effect.Effect<A, GithubError>) =>
  effect.pipe(
    Effect.catchTag("GithubHttpError", (e: GithubHttpError) =>
      e.status === 404 ? Effect.succeed(null) : Effect.fail(e),
    ),
  );

interface RawCommit {
  readonly sha: string;
  readonly author: { readonly login: string } | null;
  readonly commit: { readonly author: { readonly email: string } | null };
}
const authorOf = (c: RawCommit): CommitAuthor => ({
  sha: c.sha,
  login: c.author?.login ?? null,
  email: c.commit.author?.email ?? null,
});

const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");

export interface WritesOptions extends GithubClientOptions {
  /** Release asset uploads go to this host; GitHub serves them from `uploads.github.com`. */
  readonly uploadsUrl?: string;
}

export const githubWritesLayer = (options: WritesOptions) =>
  Layer.effect(
    GithubWrites,
    Effect.gen(function* () {
      const quota = yield* InstallationQuota;
      const request = restRequest(options, quota);
      return {
        listComments: ({ installation, repo, issue }) =>
          request(installation, "GET", `/repos/${repo}/issues/${issue}/comments?per_page=100`),
        createComment: ({ installation, repo, issue, body }) =>
          request(installation, "POST", `/repos/${repo}/issues/${issue}/comments`, { body }),
        updateComment: ({ installation, repo, comment, body }) =>
          request(installation, "PATCH", `/repos/${repo}/issues/comments/${comment}`, { body }),
        listReviews: ({ installation, repo, pull }) =>
          request(installation, "GET", `/repos/${repo}/pulls/${pull}/reviews?per_page=100`),
        createReview: ({ installation, repo, pull, body, commitId }) =>
          request(installation, "POST", `/repos/${repo}/pulls/${pull}/reviews`, {
            body,
            event: "COMMENT",
            ...(commitId === undefined ? {} : { commit_id: commitId }),
          }),
        issuesPage: ({ installation, repo, page }) =>
          request(
            installation,
            "GET",
            `/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
          ),
        createIssue: ({ installation, repo, title, body, labels }) =>
          request(installation, "POST", `/repos/${repo}/issues`, { title, body, labels }),
        updateIssue: ({ installation, repo, issue, title, body }) =>
          request(installation, "PATCH", `/repos/${repo}/issues/${issue}`, { title, body }),
        addLabels: ({ installation, repo, issue, labels }) =>
          Effect.asVoid(
            request(installation, "POST", `/repos/${repo}/issues/${issue}/labels`, { labels }),
          ),
        removeLabel: ({ installation, repo, issue, label }) =>
          Effect.asVoid(
            notFoundAsNull(
              request(
                installation,
                "DELETE",
                `/repos/${repo}/issues/${issue}/labels/${encodeURIComponent(label)}`,
              ),
            ),
          ),
        branch: ({ installation, repo, branch }) =>
          notFoundAsNull(
            request<{ readonly commit: { readonly sha: string }; readonly protected: boolean }>(
              installation,
              "GET",
              `/repos/${repo}/branches/${enc(branch)}`,
            ),
          ).pipe(
            Effect.map((b) => (b === null ? null : { sha: b.commit.sha, protected: b.protected })),
          ),
        commit: ({ installation, repo, sha }) =>
          request(installation, "GET", `/repos/${repo}/git/commits/${sha}`),
        commitsBetween: ({ installation, repo, base, head }) =>
          request<{ readonly commits: readonly RawCommit[] }>(
            installation,
            "GET",
            `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100`,
          ).pipe(Effect.map((r) => r.commits.map(authorOf))),
        createBlob: ({ installation, repo, base64 }) =>
          request(installation, "POST", `/repos/${repo}/git/blobs`, {
            content: base64,
            encoding: "base64",
          }),
        createTree: ({ installation, repo, baseTree, entries }) =>
          request(installation, "POST", `/repos/${repo}/git/trees`, {
            base_tree: baseTree,
            tree: entries.map((e) => ({ path: e.path, mode: e.mode, type: "blob", sha: e.sha })),
          }),
        createCommit: ({ installation, repo, message, tree, parents, author }) =>
          request(installation, "POST", `/repos/${repo}/git/commits`, {
            message,
            tree,
            parents,
            author,
          }),
        setBranch: ({ installation, repo, branch, sha, exists }) =>
          Effect.asVoid(
            exists
              ? request(installation, "PATCH", `/repos/${repo}/git/refs/heads/${enc(branch)}`, {
                  sha,
                  force: true,
                })
              : request(installation, "POST", `/repos/${repo}/git/refs`, {
                  ref: `refs/heads/${branch}`,
                  sha,
                }),
          ),
        openPulls: ({ installation, repo, head }) =>
          request(
            installation,
            "GET",
            `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(head)}&per_page=100`,
          ),
        pull: ({ installation, repo, pull }) =>
          request(installation, "GET", `/repos/${repo}/pulls/${pull}`),
        pullCommits: ({ installation, repo, pull }) =>
          request<readonly RawCommit[]>(
            installation,
            "GET",
            `/repos/${repo}/pulls/${pull}/commits?per_page=100`,
          ).pipe(Effect.map((cs) => cs.map(authorOf))),
        createPull: ({ installation, repo, title, body, head, base, draft }) =>
          request(installation, "POST", `/repos/${repo}/pulls`, { title, body, head, base, draft }),
        closePull: ({ installation, repo, pull }) =>
          request(installation, "PATCH", `/repos/${repo}/pulls/${pull}`, { state: "closed" }),
        releases: ({ installation, repo }) =>
          request(installation, "GET", `/repos/${repo}/releases?per_page=100`),
        createDraftRelease: ({ installation, repo, tag, target, name, body }) =>
          request(installation, "POST", `/repos/${repo}/releases`, {
            tag_name: tag,
            target_commitish: target,
            name,
            body,
            draft: true,
          }),
        publishRelease: ({ installation, repo, release }) =>
          request(installation, "PATCH", `/repos/${repo}/releases/${release}`, { draft: false }),
        uploadAsset: ({ installation, repo, release, name, contentType, bytes }) =>
          Effect.gen(function* () {
            const token = yield* options.token(installation, false);
            const base = options.uploadsUrl ?? "https://uploads.github.com";
            const response = yield* Effect.tryPromise({
              try: (signal) =>
                options.fetch(
                  `${base}/repos/${repo}/releases/${release}/assets?name=${encodeURIComponent(name)}`,
                  {
                    method: "POST",
                    signal,
                    headers: {
                      accept: "application/vnd.github+json",
                      authorization: `Bearer ${token}`,
                      "content-type": contentType,
                      "x-github-api-version": "2022-11-28",
                    },
                    body: bytes.slice().buffer,
                  },
                ),
              catch: (e) => new GithubNetworkError({ sent: true, message: String(e) }),
            });
            yield* quota.observe(
              String(installation),
              observeHeaders(response.headers, yield* Clock.currentTimeMillis),
            );
            if (response.ok) return;
            return yield* new GithubHttpError({
              status: response.status,
              message: response.statusText,
              rateLimited: response.status === 429,
            });
          }),
        refreshToken: (installation) => Effect.asVoid(options.token(installation, true)),
      };
    }),
  );
