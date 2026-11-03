// An in-memory GitHub repository behind the `GitData` service, recording every call.
import { createHash } from "node:crypto";
import { Effect, Layer } from "effect";
import { GitData, GitDataError, type BranchCommit, type PullRef } from "./git-data.ts";

interface Commit extends BranchCommit {
  readonly tree: string;
  readonly parents: readonly string[];
}

export interface FakeRepo {
  readonly calls: string[];
  readonly refs: Map<string, string>;
  readonly commits: Map<string, Commit>;
  readonly blobs: Map<string, Uint8Array>;
  readonly files: Map<string, Uint8Array>;
  readonly pulls: (PullRef & {
    title: string;
    body: string;
    draft: boolean;
    base: string;
    open: boolean;
    labels: string[];
  })[];
  readonly protectedBranches: Set<string>;
  failNext: { call: string; status: number } | null;
}

export const BASE_SHA = "b".repeat(40);

export const fakeRepo = (): FakeRepo => {
  const commits = new Map<string, Commit>([
    [
      BASE_SHA,
      { sha: BASE_SHA, message: "base", authorLogin: "dev", tree: "tree-base", parents: [] },
    ],
  ]);
  return {
    calls: [],
    refs: new Map([["main", BASE_SHA]]),
    commits,
    blobs: new Map(),
    files: new Map(),
    pulls: [],
    protectedBranches: new Set(["main"]),
    failNext: null,
  };
};

const hash = (text: string) => createHash("sha1").update(text).digest("hex");

export const fakeGitLayer = (
  repo: FakeRepo,
  appLogin = "flare-dispatch[bot]",
): Layer.Layer<GitData> => {
  const record = <A>(name: string, f: () => A): Effect.Effect<A, GitDataError> =>
    Effect.suspend(() => {
      repo.calls.push(name);
      if (repo.failNext !== null && repo.failNext.call === name) {
        const status = repo.failNext.status;
        repo.failNext = null;
        return Effect.fail(new GitDataError({ call: name, status, detail: "injected" }));
      }
      return Effect.succeed(f());
    });
  return Layer.succeed(GitData, {
    defaultBranch: () => record("defaultBranch", () => "main"),
    branchProtected: (_r, b) => record("branchProtected", () => repo.protectedBranches.has(b)),
    refSha: (_r, b) => record("refSha", () => repo.refs.get(b) ?? null),
    commitsSince: (_r, base, head) =>
      record("commitsSince", () => {
        const out: BranchCommit[] = [];
        let at: string | undefined = head;
        while (at !== undefined && at !== base) {
          const c = repo.commits.get(at);
          if (c === undefined) break;
          out.push(c);
          at = c.parents[0];
        }
        return out;
      }),
    commit: (_r, sha) =>
      record("commit", () => {
        const c = repo.commits.get(sha);
        if (c === undefined) throw new Error(`no commit ${sha}`);
        return c;
      }),
    fileAt: (_r, _c, path) => record("fileAt", () => repo.files.get(path) ?? null),
    createBlob: (_r, bytes) =>
      record("createBlob", () => {
        const sha = hash(Buffer.from(bytes).toString("binary"));
        repo.blobs.set(sha, bytes);
        return sha;
      }),
    createTree: (_r, base, entries) =>
      record("createTree", () => hash(base + JSON.stringify(entries))),
    createCommit: (_r, input) =>
      record("createCommit", () => {
        const sha = hash(JSON.stringify(input));
        repo.commits.set(sha, {
          sha,
          message: input.message,
          authorLogin: appLogin,
          tree: input.tree,
          parents: input.parents,
        });
        return sha;
      }),
    createRef: (_r, b, sha) => record("createRef", () => void repo.refs.set(b, sha)),
    updateRef: (_r, b, sha) => record("updateRef", () => void repo.refs.set(b, sha)),
    openPull: (_r, head) =>
      record("openPull", () => {
        const p = repo.pulls.find((x) => x.head === head && x.open);
        return p === undefined ? null : { number: p.number, url: p.url, head: p.head };
      }),
    createPull: (_r, input) =>
      record("createPull", () => {
        const number = repo.pulls.length + 1;
        const pull = {
          ...input,
          number,
          url: `https://github.com/o/r/pull/${number}`,
          open: true,
          labels: [],
        };
        repo.pulls.push(pull);
        return { number, url: pull.url, head: input.head };
      }),
    updatePull: (_r, number, input) =>
      record("updatePull", () => {
        const p = repo.pulls.find((x) => x.number === number);
        if (p !== undefined) Object.assign(p, input);
      }),
    addLabels: (_r, number, labels) =>
      record("addLabels", () => {
        repo.pulls.find((x) => x.number === number)?.labels.push(...labels);
      }),
    closePull: (_r, number) =>
      record("closePull", () => {
        const p = repo.pulls.find((x) => x.number === number);
        if (p !== undefined) p.open = false;
      }),
  });
};
