// Unit tests for the auto-merge gate — the one place software reaches `main`
// without a human, so the tests are mostly about it saying no.
//
// The pure half (`parseAutomergeConfig`, `evaluateAutomerge`,
// `matchesSensitivePath`) needs no fakes at all. `loadAutomergeConfig` is
// exercised against the `github` fake plus a hand-built failing service, since
// "unreadable ⇒ refuse" is the condition that matters most and the fake never
// fails on its own.

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { GitHubApiError } from "../errors";
import { Github, type GithubService } from "../services/github";
import { makeCFRuntimeTest } from "../testing";
import {
  AUTOMERGE_CONFIG_CLOSED,
  AUTOMERGE_CONFIG_PATH,
  type AutomergeConfig,
  describeVerdict,
  evaluateAutomerge,
  loadAutomergeConfig,
  matchesSensitivePath,
  type MergeCandidate,
  parseAutomergeConfig,
} from "./automerge-gate";

/**
 * A config in the shape a deployment actually ships: the gate off, no repo or
 * class opted in, and a sensitive-path list broad enough that the "even if it
 * were enabled" assertions below have something to bite on.
 */
const SHIPPED_CONFIG = JSON.stringify({
  version: 1,
  enabled: false,
  repos: [],
  classes: [],
  dailyRateLimit: 3,
  sensitivePaths: [
    "wrangler.jsonc",
    ".github/",
    "CODEOWNERS",
    "migrations/",
    "*secret*",
    "*auth*",
    "*token*",
    "maintenance/",
    "specs/",
  ],
  neverEligibleRuns: ["org-spec-audit", "spec-drift-pr", "upstream-upgrade-pr"],
});

/**
 * A config that permits — deliberately NOT the shipped one. Every refusal test
 * starts from this so it proves the named condition did the refusing, rather
 * than riding on `enabled: false` doing all the work.
 */
const PERMISSIVE: AutomergeConfig = {
  enabled: true,
  repos: ["owner/app"],
  classes: ["dependency-patch"],
  botAuthors: ["dependabot[bot]"],
  sensitivePaths: ["specs/", "*secret*", "CODEOWNERS"],
  neverEligibleRuns: ["org-spec-audit", "spec-drift-pr", "upstream-upgrade-pr"],
  dailyRateLimit: 3,
};

const candidate = (over: Partial<MergeCandidate> = {}): MergeCandidate => ({
  repo: "owner/app",
  number: 12,
  author: "dependabot[bot]",
  changeClass: "dependency-patch",
  changedPaths: ["package.json", "pnpm-lock.yaml"],
  checksGreen: true,
  reviewPosted: true,
  mergesToday: 0,
  ...over,
});

describe("parseAutomergeConfig", () => {
  it("reads the shipped config as off, with its paths and never-eligible runs", () => {
    const { config, malformed } = parseAutomergeConfig(SHIPPED_CONFIG);
    expect(malformed).toBeUndefined();
    expect(config.enabled).toBe(false);
    expect(config.repos).toEqual([]);
    expect(config.neverEligibleRuns).toContain("spec-drift-pr");
    expect(config.sensitivePaths).toContain("specs/");
  });

  it("refuses to coerce a truthy `enabled` — only the literal boolean opens it", () => {
    for (const raw of ['{"enabled":"true"}', '{"enabled":1}', '{"enabled":"yes"}', "{}"]) {
      expect(parseAutomergeConfig(raw).config.enabled).toBe(false);
    }
    expect(parseAutomergeConfig('{"enabled":true}').config.enabled).toBe(true);
  });

  it("yields the closed config for anything unparseable", () => {
    for (const raw of ["not json", "[]", "null", '"a string"']) {
      const { config, malformed } = parseAutomergeConfig(raw);
      expect(config).toEqual(AUTOMERGE_CONFIG_CLOSED);
      expect(malformed).toBeDefined();
    }
  });

  it("drops non-string entries rather than trusting a mixed array", () => {
    const { config } = parseAutomergeConfig(
      '{"enabled":true,"repos":["owner/a",42,null,{"x":1},"owner/b"]}',
    );
    expect(config.repos).toEqual(["owner/a", "owner/b"]);
  });

  it("treats a missing or nonsense rate limit as zero — which refuses", () => {
    expect(parseAutomergeConfig("{}").config.dailyRateLimit).toBe(0);
    expect(parseAutomergeConfig('{"dailyRateLimit":-3}').config.dailyRateLimit).toBe(0);
    expect(parseAutomergeConfig('{"dailyRateLimit":"3"}').config.dailyRateLimit).toBe(0);
  });
});

describe("matchesSensitivePath", () => {
  it("treats a trailing slash as a directory prefix", () => {
    expect(matchesSensitivePath("specs/03-dsl.md", "specs/")).toBe(true);
    expect(matchesSensitivePath("specs", "specs/")).toBe(true);
    expect(matchesSensitivePath("src/specs-helper.ts", "specs/")).toBe(false);
  });

  it("treats *x* as a case-insensitive substring", () => {
    expect(matchesSensitivePath("src/authGuard.ts", "*auth*")).toBe(true);
    expect(matchesSensitivePath("src/MY_SECRET.ts", "*secret*")).toBe(true);
    expect(matchesSensitivePath("src/plain.ts", "*secret*")).toBe(false);
  });

  it("matches a bare name exactly, at any depth", () => {
    expect(matchesSensitivePath("CODEOWNERS", "CODEOWNERS")).toBe(true);
    expect(matchesSensitivePath(".github/CODEOWNERS", "CODEOWNERS")).toBe(true);
    expect(matchesSensitivePath("docs/CODEOWNERS.md", "CODEOWNERS")).toBe(false);
  });
});

describe("evaluateAutomerge — the refusals", () => {
  it("refuses everything when the config is off", () => {
    const verdict = evaluateAutomerge(parseAutomergeConfig(SHIPPED_CONFIG).config, candidate());
    expect(verdict).toMatchObject({ permitted: false, reason: "disabled" });
  });

  it("refuses everything on the closed config an unreadable file yields", () => {
    const verdict = evaluateAutomerge(AUTOMERGE_CONFIG_CLOSED, candidate());
    expect(verdict.permitted).toBe(false);
  });

  it("refuses a repo nobody opted in", () => {
    const verdict = evaluateAutomerge(PERMISSIVE, candidate({ repo: "owner/other" }));
    expect(verdict).toMatchObject({ permitted: false, reason: "repo-not-opted-in" });
  });

  it("refuses a never-eligible run even when its class and repo are opted in", () => {
    // The important one: `spec-drift-pr` emits a specs/-only diff that would
    // pass every green-check condition trivially.
    const verdict = evaluateAutomerge(
      { ...PERMISSIVE, classes: ["dependency-patch", "inert-prose-only"] },
      candidate({ producedByRun: "spec-drift-pr", changeClass: "inert-prose-only" }),
    );
    expect(verdict).toMatchObject({ permitted: false, reason: "never-eligible-run" });
  });

  it("refuses every run on the shipped never-eligible list", () => {
    for (const run of ["org-spec-audit", "spec-drift-pr", "upstream-upgrade-pr"]) {
      const verdict = evaluateAutomerge(PERMISSIVE, candidate({ producedByRun: run }));
      expect(`${run}:${verdict.permitted}`).toBe(`${run}:false`);
    }
  });

  it("refuses an undeclared change class", () => {
    const verdict = evaluateAutomerge(PERMISSIVE, candidate({ changeClass: undefined }));
    expect(verdict).toMatchObject({ permitted: false, reason: "class-not-opted-in" });
  });

  it("refuses a major bump class that is simply not on the list", () => {
    const verdict = evaluateAutomerge(PERMISSIVE, candidate({ changeClass: "dependency-major" }));
    expect(verdict).toMatchObject({ permitted: false, reason: "class-not-opted-in" });
  });

  it("refuses a human author, and an author it cannot place", () => {
    for (const author of ["a-real-person", "", "some-external-contributor"]) {
      const verdict = evaluateAutomerge(PERMISSIVE, candidate({ author }));
      expect(verdict).toMatchObject({ permitted: false, reason: "human-author" });
    }
  });

  it("refuses a diff touching a sensitive path, and names the file", () => {
    const verdict = evaluateAutomerge(
      PERMISSIVE,
      candidate({ changedPaths: ["package.json", "specs/03-dsl.md"] }),
    );
    expect(verdict).toMatchObject({ permitted: false, reason: "sensitive-path" });
    expect(verdict.permitted === false && verdict.detail).toContain("specs/03-dsl.md");
  });

  it("refuses on red checks, on a missing pr-review, and at the rate limit", () => {
    expect(evaluateAutomerge(PERMISSIVE, candidate({ checksGreen: false }))).toMatchObject({
      reason: "checks-not-green",
    });
    expect(evaluateAutomerge(PERMISSIVE, candidate({ reviewPosted: false }))).toMatchObject({
      reason: "review-not-posted",
    });
    expect(evaluateAutomerge(PERMISSIVE, candidate({ mergesToday: 3 }))).toMatchObject({
      reason: "rate-limited",
    });
  });
});

describe("evaluateAutomerge — the one path that permits", () => {
  it("permits only the full conjunction, and only at rung 0", () => {
    const verdict = evaluateAutomerge(PERMISSIVE, candidate());
    expect(verdict).toEqual({ permitted: true, rung: 0 });
    // Even a permit must not read as "merged" — the ladder does not exist.
    expect(describeVerdict(verdict)).toContain("a human still merges");
  });

  it("permits a loop-authored PR whose run is not on the never-eligible list", () => {
    const verdict = evaluateAutomerge(
      PERMISSIVE,
      candidate({ producedByRun: "refresh-fixtures", author: "flare-dispatch[bot]" }),
    );
    expect(verdict.permitted).toBe(true);
  });

  it("cannot be permitted by the shipped config under any candidate", () => {
    // The property that matters: with what is actually committed in `org`,
    // there is no PR shape that merges itself.
    const shipped = parseAutomergeConfig(SHIPPED_CONFIG).config;
    for (const over of [
      {},
      { producedByRun: "refresh-fixtures" },
      { changedPaths: [] },
      { author: "dependabot[bot]", changeClass: "dependency-patch" },
    ]) {
      expect(evaluateAutomerge(shipped, candidate(over)).permitted).toBe(false);
    }
  });
});

// --- loadAutomergeConfig: unreadable must mean refuse -----------------------

const githubService = (over: Partial<GithubService>): GithubService => ({
  repositories: () => Effect.succeed([]),
  openPullRequests: () => Effect.succeed([]),
  actionRuns: () => Effect.succeed([]),
  pullRequestHistory: () => Effect.succeed([]),
  readTextFile: () => Effect.succeed({ found: false }),
  pullReview: () => Effect.void,
  openDraftPullRequest: () => Effect.succeed({ number: 0, url: "", created: false }),
  createRelease: () => Effect.succeed({ id: 0, url: "", tag: "", published: false }),
  ...over,
});

const load = (service: Partial<GithubService>) => {
  const { layer, handles } = makeCFRuntimeTest();
  return Effect.runPromise(
    loadAutomergeConfig({ repo: "owner/control" }).pipe(
      Effect.provide(Layer.succeed(Github, githubService(service))),
      Effect.provide(layer),
      Effect.map((config) => ({ config, logs: handles.io.logs })),
    ),
  );
};

describe("loadAutomergeConfig", () => {
  it("returns the closed config, loudly, when the file cannot be read", async () => {
    const { config, logs } = await load({
      readTextFile: () => Effect.fail(new GitHubApiError({ status: 500, reason: "transient" })),
    });
    expect(config).toEqual(AUTOMERGE_CONFIG_CLOSED);
    expect(evaluateAutomerge(config, candidate()).permitted).toBe(false);
    expect(
      logs.some((l) => l.level === "warn" && l.msg.includes("refusing every auto-merge")),
    ).toBe(true);
  });

  it("returns the closed config, loudly, when the file is simply absent", async () => {
    const { config, logs } = await load({ readTextFile: () => Effect.succeed({ found: false }) });
    expect(config).toEqual(AUTOMERGE_CONFIG_CLOSED);
    expect(
      logs.some((l) => l.level === "warn" && l.msg.includes("no maintenance/automerge.json")),
    ).toBe(true);
  });

  it("returns the closed config, loudly, when the file is malformed", async () => {
    const { config, logs } = await load({
      readTextFile: () => Effect.succeed({ found: true, content: "{ not json" }),
    });
    expect(config).toEqual(AUTOMERGE_CONFIG_CLOSED);
    expect(logs.some((l) => l.level === "warn" && l.msg.includes("not JSON"))).toBe(true);
  });

  it("reads the real file through the github fake at the documented path", async () => {
    const { layer } = makeCFRuntimeTest({
      github: { files: { [`owner/control:${AUTOMERGE_CONFIG_PATH}`]: SHIPPED_CONFIG } },
    });
    const config = await Effect.runPromise(
      loadAutomergeConfig({ repo: "owner/control" }).pipe(Effect.provide(layer)),
    );
    expect(config.enabled).toBe(false);
    expect(config.neverEligibleRuns).toHaveLength(3);
  });
});
