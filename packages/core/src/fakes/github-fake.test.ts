// Tests for the in-memory `Github` fake — the read-only GitHub capability.
//
// Pins the filters the fake applies on `repositories()` and
// `openPullRequests()`: archived skip, pushedWithinDays cutoff, drafts skip,
// repos allow-list, updatedWithinHours cutoff, plus the call recording.

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  Github,
  type PullRequestHistoryRef,
  type PullRequestRef,
  type RepoRef,
} from "../services/github";
import { makeGithubFake } from "./github-fake";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;

const repo = (overrides: Partial<RepoRef> = {}): RepoRef => ({
  repo: "owner/repo",
  branchDefault: "main",
  installationId: 1,
  archived: false,
  pushedAt: NOW - DAY,
  ...overrides,
});

const pr = (overrides: Partial<PullRequestRef> = {}): PullRequestRef => ({
  repo: "owner/repo",
  number: 1,
  headSha: "abc",
  baseSha: "def",
  title: "Test PR",
  draft: false,
  labels: [],
  author: "alice",
  installationId: 1,
  updatedAt: NOW - HOUR,
  ...overrides,
});

describe("makeGithubFake — repositories()", () => {
  it("returns seeded repos, skipping archived by default", async () => {
    const { layer, state } = makeGithubFake({
      now: NOW,
      repositories: [
        repo({ repo: "owner/active" }),
        repo({ repo: "owner/archived", archived: true }),
      ],
    });
    const result = await Effect.runPromise(
      Effect.flatMap(Github, (g) => g.repositories()).pipe(Effect.provide(layer)),
    );
    expect(result.map((r) => r.repo)).toEqual(["owner/active"]);
    expect(state.repositoriesCalls).toHaveLength(1);
    expect(state.repositoriesCalls[0]).toEqual({
      includeArchived: false,
      pushedWithinDays: undefined,
    });
  });

  it("includeArchived: true returns archived repos too", async () => {
    const { layer } = makeGithubFake({
      now: NOW,
      repositories: [
        repo({ repo: "owner/active" }),
        repo({ repo: "owner/archived", archived: true }),
      ],
    });
    const result = await Effect.runPromise(
      Effect.flatMap(Github, (g) => g.repositories({ includeArchived: true })).pipe(
        Effect.provide(layer),
      ),
    );
    expect(result.map((r) => r.repo).sort()).toEqual(["owner/active", "owner/archived"]);
  });

  it("pushedWithinDays cutoff filters idle repos", async () => {
    const { layer } = makeGithubFake({
      now: NOW,
      repositories: [
        repo({ repo: "owner/fresh", pushedAt: NOW - 2 * DAY }),
        repo({ repo: "owner/stale", pushedAt: NOW - 60 * DAY }),
      ],
    });
    const result = await Effect.runPromise(
      Effect.flatMap(Github, (g) => g.repositories({ pushedWithinDays: 7 })).pipe(
        Effect.provide(layer),
      ),
    );
    expect(result.map((r) => r.repo)).toEqual(["owner/fresh"]);
  });
});

describe("makeGithubFake — openPullRequests()", () => {
  it("skips drafts by default", async () => {
    const { layer, state } = makeGithubFake({
      now: NOW,
      pullRequests: [pr({ number: 1, draft: false }), pr({ number: 2, draft: true })],
    });
    const result = await Effect.runPromise(
      Effect.flatMap(Github, (g) => g.openPullRequests()).pipe(Effect.provide(layer)),
    );
    expect(result.map((p) => p.number)).toEqual([1]);
    expect(state.openPullRequestsCalls[0]).toEqual({
      includeDrafts: false,
      updatedWithinHours: undefined,
      repos: undefined,
    });
  });

  it("includeDrafts: true returns drafts", async () => {
    const { layer } = makeGithubFake({
      now: NOW,
      pullRequests: [pr({ number: 1, draft: true })],
    });
    const result = await Effect.runPromise(
      Effect.flatMap(Github, (g) => g.openPullRequests({ includeDrafts: true })).pipe(
        Effect.provide(layer),
      ),
    );
    expect(result.map((p) => p.number)).toEqual([1]);
  });

  it("repos allow-list scopes results", async () => {
    const { layer } = makeGithubFake({
      now: NOW,
      pullRequests: [
        pr({ repo: "owner/a", number: 1 }),
        pr({ repo: "owner/b", number: 2 }),
        pr({ repo: "owner/c", number: 3 }),
      ],
    });
    const result = await Effect.runPromise(
      Effect.flatMap(Github, (g) => g.openPullRequests({ repos: ["owner/a", "owner/c"] })).pipe(
        Effect.provide(layer),
      ),
    );
    expect(result.map((p) => `${p.repo}#${p.number}`).sort()).toEqual(["owner/a#1", "owner/c#3"]);
  });

  it("updatedWithinHours cutoff filters stale PRs", async () => {
    const { layer } = makeGithubFake({
      now: NOW,
      pullRequests: [
        pr({ number: 1, updatedAt: NOW - 2 * HOUR }),
        pr({ number: 2, updatedAt: NOW - 48 * HOUR }),
      ],
    });
    const result = await Effect.runPromise(
      Effect.flatMap(Github, (g) => g.openPullRequests({ updatedWithinHours: 24 })).pipe(
        Effect.provide(layer),
      ),
    );
    expect(result.map((p) => p.number)).toEqual([1]);
  });

  it("records each call", async () => {
    const { layer, state } = makeGithubFake();
    await Effect.runPromise(
      Effect.gen(function* () {
        const g = yield* Github;
        yield* g.openPullRequests();
        yield* g.openPullRequests({ updatedWithinHours: 12 });
        yield* g.openPullRequests({ repos: ["x/y"] });
      }).pipe(Effect.provide(layer)),
    );
    expect(state.openPullRequestsCalls).toHaveLength(3);
  });
});

describe("makeGithubFake — pullRequestHistory() / readTextFile()", () => {
  const history = (over: Partial<PullRequestHistoryRef> = {}): PullRequestHistoryRef => ({
    repo: "owner/control",
    number: 12,
    title: "docs(maintenance): open questions",
    body: "maintenance-key: org-spec-audit/spend-caps",
    headBranch: "flare-dispatch/spec-audit-questions-2026-07-01",
    state: "closed",
    draft: true,
    url: "https://github.com/owner/control/pull/12",
    createdAt: NOW - 40 * DAY,
    updatedAt: NOW - 5 * DAY,
    closedAt: NOW - 5 * DAY,
    ...over,
  });

  it("filters by repo, state, and head-branch prefix", async () => {
    const { layer, state } = makeGithubFake({
      now: NOW,
      pullRequestHistory: [
        history({ number: 1 }),
        history({ number: 2, repo: "owner/other" }),
        history({ number: 3, headBranch: "feat/unrelated" }),
        history({ number: 4, updatedAt: NOW - 90 * DAY }),
        history({ number: 5, state: "open", closedAt: undefined }),
      ],
    });
    const result = await Effect.runPromise(
      Effect.flatMap(Github, (g) =>
        g.pullRequestHistory({
          repo: "owner/control",
          headBranchPrefix: "flare-dispatch/spec-audit-questions-",
          state: "closed",
          updatedWithinDays: 30,
        }),
      ).pipe(Effect.provide(layer)),
    );
    // #4 is outside the 30-day window but still returned: `updatedWithinDays`
    // is a pagination bound, and the live read only stops FETCHING at it — the
    // out-of-window rows sharing a page with in-window ones come back. A fake
    // that filtered them would be stricter than production.
    expect(result.map((p) => p.number)).toEqual([1, 4]);
    expect(state.pullRequestHistoryCalls).toHaveLength(1);
  });

  it("returns newest-updated first, matching the live sort", async () => {
    const { layer } = makeGithubFake({
      now: NOW,
      // Seeded oldest-first, so insertion order and the contract disagree.
      pullRequestHistory: [
        history({ number: 1, updatedAt: NOW - 20 * DAY }),
        history({ number: 2, updatedAt: NOW - 1 * DAY }),
        history({ number: 3, updatedAt: NOW - 10 * DAY }),
      ],
    });
    const result = await Effect.runPromise(
      Effect.flatMap(Github, (g) => g.pullRequestHistory({ repo: "owner/control" })).pipe(
        Effect.provide(layer),
      ),
    );
    expect(result.map((p) => p.number)).toEqual([2, 3, 1]);
  });

  it("stops at maxPages, dropping the rows past the cap", async () => {
    const { layer } = makeGithubFake({
      now: NOW,
      historyPageSize: 2,
      pullRequestHistory: [
        history({ number: 1, updatedAt: NOW - 1 * DAY }),
        history({ number: 2, updatedAt: NOW - 2 * DAY }),
        history({ number: 3, updatedAt: NOW - 3 * DAY }),
        history({ number: 4, updatedAt: NOW - 4 * DAY }),
        history({ number: 5, updatedAt: NOW - 5 * DAY }),
      ],
    });
    const result = await Effect.runPromise(
      Effect.flatMap(Github, (g) =>
        g.pullRequestHistory({ repo: "owner/control", maxPages: 2 }),
      ).pipe(Effect.provide(layer)),
    );
    // Two pages of two — #5 is past the cap and never fetched, which is exactly
    // how a repo with more history than the cap loses its oldest rows in prod.
    expect(result.map((p) => p.number)).toEqual([1, 2, 3, 4]);
  });

  it("stops paginating once a page runs past the update window", async () => {
    const { layer } = makeGithubFake({
      now: NOW,
      historyPageSize: 2,
      pullRequestHistory: [
        history({ number: 1, updatedAt: NOW - 1 * DAY }),
        history({ number: 2, updatedAt: NOW - 90 * DAY }),
        history({ number: 3, updatedAt: NOW - 91 * DAY }),
      ],
    });
    const result = await Effect.runPromise(
      Effect.flatMap(Github, (g) =>
        g.pullRequestHistory({ repo: "owner/control", updatedWithinDays: 30, maxPages: 5 }),
      ).pipe(Effect.provide(layer)),
    );
    // Page 1 is [#1, #2]; its oldest predates the cutoff, so page 2 is never
    // fetched and #3 never appears — the cap is not what stopped it.
    expect(result.map((p) => p.number)).toEqual([1, 2]);
  });

  it("answers a ref-pinned file when the caller names that ref", async () => {
    const { layer, state } = makeGithubFake({
      files: {
        "owner/control:maintenance/declined.jsonl": "default-branch",
        "owner/control@release/2026-08:maintenance/declined.jsonl": "on-the-release-branch",
      },
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const g = yield* Github;
        return [
          yield* g.readTextFile({
            repo: "owner/control",
            path: "maintenance/declined.jsonl",
            ref: "release/2026-08",
          }),
          // An unseeded ref falls back to the bare key — what most tests want.
          yield* g.readTextFile({
            repo: "owner/control",
            path: "maintenance/declined.jsonl",
            ref: "some-other-branch",
          }),
          yield* g.readTextFile({ repo: "owner/control", path: "maintenance/declined.jsonl" }),
        ];
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual([
      { found: true, content: "on-the-release-branch" },
      { found: true, content: "default-branch" },
      { found: true, content: "default-branch" },
    ]);
    expect(state.readTextFileCalls[0]?.ref).toBe("release/2026-08");
  });

  it("answers a seeded file, and found:false for anything else", async () => {
    const { layer, state } = makeGithubFake({
      files: { "owner/control:maintenance/declined.jsonl": '{"key":"a/b"}' },
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const g = yield* Github;
        return [
          yield* g.readTextFile({
            repo: "owner/control",
            path: "maintenance/declined.jsonl",
          }),
          yield* g.readTextFile({ repo: "owner/control", path: "nope.jsonl" }),
        ];
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual([{ found: true, content: '{"key":"a/b"}' }, { found: false }]);
    expect(state.readTextFileCalls).toHaveLength(2);
  });
});
