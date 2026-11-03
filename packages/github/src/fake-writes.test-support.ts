// An in-memory repository for the side-output appliers: comments, reviews,
// issues, labels, git objects and branches, pull requests and releases, with a
// scripted failure queue and a record of every call.
import { Effect, Layer } from "effect";
import type { GithubError } from "./client.ts";
import {
  GithubWrites,
  type CommitAuthor,
  type IssueRef,
  type PullRef,
  type TreeEntry,
} from "./writes.ts";

interface FakeCommit {
  readonly sha: string;
  readonly message: string;
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: { readonly login: string | null; readonly email: string };
}

export interface FakeSide {
  readonly comments: Map<number, { id: number; body: string }[]>;
  readonly reviews: Map<number, { id: number; body: string }[]>;
  readonly issues: (IssueRef & { title: string; labels: string[] })[];
  readonly labels: Map<number, Set<string>>;
  readonly branches: Map<string, { sha: string; protected: boolean }>;
  readonly commits: Map<string, FakeCommit>;
  readonly blobs: Map<string, string>;
  readonly trees: Map<string, readonly TreeEntry[]>;
  readonly pulls: PullRef[];
  readonly pullCommits: Map<number, CommitAuthor[]>;
  readonly releases: { id: number; tag_name: string; draft: boolean; assets: { name: string }[] }[];
  readonly calls: string[];
  /** Failures the next calls take, in order; a `null` entry lets that call through. */
  readonly failures: (GithubError | null)[];
  /** Errors answered after the next write takes effect. */
  readonly lostAnswers: GithubError[];
  tokenRefreshes: number;
  nextId: number;
}

export const BOT = {
  login: "flare-dispatch[bot]",
  name: "flare-dispatch[bot]",
  email: "bot@example.com",
};

export const fakeSide = (): FakeSide => {
  const root: FakeCommit = {
    sha: "base0",
    message: "root",
    tree: "tree0",
    parents: [],
    author: { login: "alice", email: "alice@example.com" },
  };
  return {
    comments: new Map(),
    reviews: new Map(),
    issues: [],
    labels: new Map(),
    branches: new Map([["main", { sha: root.sha, protected: true }]]),
    commits: new Map([[root.sha, root]]),
    blobs: new Map(),
    trees: new Map([["tree0", []]]),
    pulls: [],
    pullCommits: new Map(),
    releases: [],
    calls: [],
    failures: [],
    lostAnswers: [],
    tokenRefreshes: 0,
    nextId: 100,
  };
};

/** Adds a commit on `branch` by `author`, creating the branch from `from` when absent. */
export const commitOn = (
  s: FakeSide,
  branch: string,
  author: { login: string | null; email: string },
  from = "main",
) => {
  const parent = s.branches.get(branch)?.sha ?? s.branches.get(from)!.sha;
  const sha = `c${s.nextId++}`;
  s.commits.set(sha, { sha, message: "change", tree: "tree0", parents: [parent], author });
  s.branches.set(branch, { sha, protected: false });
  return sha;
};

export const fakeWritesLayer = (s: FakeSide) => {
  const call = <A>(name: string, f: () => A, write = false): Effect.Effect<A, GithubError> =>
    Effect.suspend(() => {
      s.calls.push(name);
      const failure = s.failures.shift();
      if (failure !== undefined && failure !== null) return Effect.fail(failure);
      const value = f();
      const lost = write ? s.lostAnswers.shift() : undefined;
      return lost === undefined ? Effect.succeed(value) : Effect.fail(lost);
    });
  const id = () => s.nextId++;
  const authorsBetween = (base: string, head: string): CommitAuthor[] => {
    const stop = s.branches.get(base)?.sha ?? base;
    const out: CommitAuthor[] = [];
    let at = s.branches.get(head)?.sha ?? head;
    while (at !== stop && s.commits.has(at)) {
      const c = s.commits.get(at)!;
      out.push({ sha: c.sha, login: c.author.login, email: c.author.email });
      at = c.parents[0] ?? stop;
    }
    return out;
  };
  return Layer.succeed(GithubWrites, {
    listComments: ({ issue }) => call("listComments", () => s.comments.get(issue) ?? []),
    createComment: ({ issue, body }) =>
      call(
        "createComment",
        () => {
          const c = { id: id(), body };
          s.comments.set(issue, [...(s.comments.get(issue) ?? []), c]);
          return c;
        },
        true,
      ),
    listReviews: ({ pull }) => call("listReviews", () => s.reviews.get(pull) ?? []),
    createReview: ({ pull, body }) =>
      call(
        "createReview",
        () => {
          const r = { id: id(), body };
          s.reviews.set(pull, [...(s.reviews.get(pull) ?? []), r]);
          return r;
        },
        true,
      ),
    recentIssues: () => call("recentIssues", () => [...s.issues].reverse()),
    createIssue: ({ title, body, labels }) =>
      call(
        "createIssue",
        () => {
          const i = { id: id(), number: s.issues.length + 1, title, body, labels: [...labels] };
          s.issues.push(i);
          return i;
        },
        true,
      ),
    updateIssue: ({ issue, title, body }) =>
      call(
        "updateIssue",
        () => {
          const i = s.issues.find((x) => x.number === issue)!;
          Object.assign(i, { title, body });
          return i;
        },
        true,
      ),
    addLabels: ({ issue, labels }) =>
      call(
        "addLabels",
        () => void s.labels.set(issue, new Set([...(s.labels.get(issue) ?? []), ...labels])),
        true,
      ),
    removeLabel: ({ issue, label }) =>
      call("removeLabel", () => void s.labels.get(issue)?.delete(label), true),
    branch: ({ branch }) => call("branch", () => s.branches.get(branch) ?? null),
    commit: ({ sha }) =>
      call("commit", () => {
        const c = s.commits.get(sha)!;
        return { sha: c.sha, message: c.message, tree: { sha: c.tree } };
      }),
    commitsBetween: ({ base, head }) => call("commitsBetween", () => authorsBetween(base, head)),
    createBlob: ({ base64 }) =>
      call(
        "createBlob",
        () => {
          const sha = `blob${id()}`;
          s.blobs.set(sha, base64);
          return { sha };
        },
        true,
      ),
    createTree: ({ entries }) =>
      call(
        "createTree",
        () => {
          const sha = `tree${id()}`;
          s.trees.set(sha, entries);
          return { sha };
        },
        true,
      ),
    createCommit: ({ message, tree, parents, author }) =>
      call(
        "createCommit",
        () => {
          const sha = `c${id()}`;
          s.commits.set(sha, {
            sha,
            message,
            tree,
            parents,
            author: { login: BOT.login, email: author.email },
          });
          return { sha };
        },
        true,
      ),
    setBranch: ({ branch, sha }) =>
      call("setBranch", () => void s.branches.set(branch, { sha, protected: false }), true),
    openPulls: ({ head }) =>
      call("openPulls", () =>
        s.pulls.filter((p) => p.state === "open" && head.endsWith(`:${p.head.ref}`)),
      ),
    pull: ({ pull }) => call("pull", () => s.pulls.find((p) => p.number === pull)!),
    pullCommits: ({ pull }) =>
      call("pullCommits", () => {
        const pr = s.pulls.find((p) => p.number === pull)!;
        return s.pullCommits.get(pull) ?? authorsBetween(pr.base.ref, pr.head.ref);
      }),
    createPull: ({ head, base, draft }) =>
      call(
        "createPull",
        () => {
          const pr: PullRef = {
            id: id(),
            number: s.pulls.length + 1,
            state: "open",
            draft,
            head: { ref: head, sha: s.branches.get(head)?.sha ?? "" },
            base: { ref: base },
          };
          s.pulls.push(pr);
          return pr;
        },
        true,
      ),
    closePull: ({ pull }) =>
      call(
        "closePull",
        () => {
          const i = s.pulls.findIndex((p) => p.number === pull);
          s.pulls[i] = { ...s.pulls[i]!, state: "closed" };
          return s.pulls[i]!;
        },
        true,
      ),
    releases: () => call("releases", () => s.releases),
    createDraftRelease: ({ tag }) =>
      call(
        "createDraftRelease",
        () => {
          const r = { id: id(), tag_name: tag, draft: true, assets: [] as { name: string }[] };
          s.releases.push(r);
          return r;
        },
        true,
      ),
    publishRelease: ({ release }) =>
      call(
        "publishRelease",
        () => {
          const r = s.releases.find((x) => x.id === release)!;
          r.draft = false;
          return r;
        },
        true,
      ),
    uploadAsset: ({ release, name }) =>
      call(
        "uploadAsset",
        () => void s.releases.find((x) => x.id === release)!.assets.push({ name }),
        true,
      ),
    refreshToken: () =>
      call("refreshToken", () => {
        s.tokenRefreshes++;
      }),
  });
};
