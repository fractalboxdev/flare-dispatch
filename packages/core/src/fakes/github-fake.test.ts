// Tests for the in-memory `Github` fake — the read-only GitHub capability.
//
// Pins the filters the fake applies on `repositories()` and
// `openPullRequests()`: archived skip, pushedWithinDays cutoff, drafts skip,
// repos allow-list, updatedWithinHours cutoff, plus the call recording.

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  Github,
  type PullRequestRef,
  type RepoRef,
} from "../services/github";
import { makeGithubFake } from "./github-fake";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;

const repo = (overrides: Partial<RepoRef> = {}): RepoRef => ({
  repo: "owner/repo",
  defaultBranch: "main",
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
      Effect.flatMap(Github, (g) => g.repositories()).pipe(
        Effect.provide(layer),
      ),
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
      Effect.flatMap(Github, (g) =>
        g.repositories({ includeArchived: true }),
      ).pipe(Effect.provide(layer)),
    );
    expect(result.map((r) => r.repo).sort()).toEqual([
      "owner/active",
      "owner/archived",
    ]);
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
      Effect.flatMap(Github, (g) =>
        g.repositories({ pushedWithinDays: 7 }),
      ).pipe(Effect.provide(layer)),
    );
    expect(result.map((r) => r.repo)).toEqual(["owner/fresh"]);
  });
});

describe("makeGithubFake — openPullRequests()", () => {
  it("skips drafts by default", async () => {
    const { layer, state } = makeGithubFake({
      now: NOW,
      pullRequests: [
        pr({ number: 1, draft: false }),
        pr({ number: 2, draft: true }),
      ],
    });
    const result = await Effect.runPromise(
      Effect.flatMap(Github, (g) => g.openPullRequests()).pipe(
        Effect.provide(layer),
      ),
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
      Effect.flatMap(Github, (g) =>
        g.openPullRequests({ includeDrafts: true }),
      ).pipe(Effect.provide(layer)),
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
      Effect.flatMap(Github, (g) =>
        g.openPullRequests({ repos: ["owner/a", "owner/c"] }),
      ).pipe(Effect.provide(layer)),
    );
    expect(result.map((p) => `${p.repo}#${p.number}`).sort()).toEqual([
      "owner/a#1",
      "owner/c#3",
    ]);
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
      Effect.flatMap(Github, (g) =>
        g.openPullRequests({ updatedWithinHours: 24 }),
      ).pipe(Effect.provide(layer)),
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
