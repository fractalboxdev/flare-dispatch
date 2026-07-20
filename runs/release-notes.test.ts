// Unit tests for the `release-notes` Schedule-mode run.
//
// Drives the full lifecycle against the in-memory CF test runtime: a canned
// `git log` feeds the draft, the inline event queue stands in for the human
// gate, and we assert the `github.createRelease` capability write fires (or
// not) per decision. Plus pure-helper units for the Conventional-Commit →
// semver bump and the categorized notes rendering.

import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import {
  TEST_EXECUTION_ID_DEFAULT,
  enqueueInlineEvent,
  type InlineEventQueue,
  makeCFRuntimeTest,
} from "@fractalboxdev/flare-dispatch-core/testing";
import {
  bumpFor,
  nextVersion,
  parseConventional,
  parseGitState,
  releaseNotes,
  renderReleaseNotes,
} from "./release-notes";

const US = "";
const firedAt = Date.UTC(2026, 5, 22); // a Monday
const input = { firedAt } as const;

/** Build the labelled stdout the `collect-git` script emits. */
const gitOut = (
  lastTag: string,
  head: string,
  commits: ReadonlyArray<readonly [sha: string, subject: string, author: string]>,
): string =>
  [
    `HEAD ${head}`,
    `LASTTAG ${lastTag}`,
    ...commits.map(([s, subj, a]) => `COMMIT${US}${s}${US}${subj}${US}${a}`),
  ].join("\n");

describe("release-notes run", () => {
  it.effect("opens the release PR and publishes on approval", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        "git log": {
          exitCode: 0,
          stdout: gitOut("", "headsha000000000000", [
            ["sha1", "feat: add widget (#10)", "alice"],
            ["sha2", "fix: off-by-one (#11)", "bob"],
          ]),
        },
      },
      eventQueue: ((): InlineEventQueue => {
        const q: InlineEventQueue = new Map();
        enqueueInlineEvent(q, "release-approval", {
          decision: "approve",
          decider: "alice",
        });
        return q;
      })(),
    });

    return Effect.gen(function* () {
      const out = yield* releaseNotes.run(input);

      expect(out.published).toBe(true);
      expect(out.reason).toBe("published");
      // No prior tag + a feat ⇒ first release is v0.1.0.
      expect(out.tag).toBe("v0.1.0");
      expect(out.releaseUrl).toContain("/releases/tag/v0.1.0");
      expect(out.prNumber).toBeGreaterThan(0);

      // The approval PR carries the notes file + the wfId marker (pinned to
      // THIS run's instance id) so the webhook can resume it, and is non-draft.
      const prs = handles.github.openDraftPullRequestCalls;
      expect(prs).toHaveLength(1);
      expect(prs[0]!.headBranch).toBe("flare-dispatch/release-v0.1.0");
      expect(prs[0]!.draft).toBe(false);
      expect(prs[0]!.files[0]!.path).toBe(".flare-dispatch/releases/v0.1.0.md");
      expect(prs[0]!.body).toContain(
        `<!-- flare-dispatch:release-approval wf=${TEST_EXECUTION_ID_DEFAULT} tag=v0.1.0 -->`,
      );

      // The release write fired exactly once, pinned to the drafted HEAD sha.
      const calls = handles.github.createReleaseCalls;
      expect(calls).toHaveLength(1);
      expect(calls[0]!.repo).toBe("fractalbox/flare-dispatch");
      expect(calls[0]!.tag).toBe("v0.1.0");
      expect(calls[0]!.target).toBe("headsha000000000000");
      expect(calls[0]!.body).toContain("### 🚀 Features");
      expect(calls[0]!.body).toContain("### 🐛 Fixes");
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops without publishing when the decision is reject", () => {
    const q: InlineEventQueue = new Map();
    enqueueInlineEvent(q, "release-approval", {
      decision: "reject",
      decider: "carol",
    });
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        "git log": {
          exitCode: 0,
          stdout: gitOut("v1.2.3", "headshaXYZ", [
            ["sha1", "fix: patch a thing (#20)", "carol"],
          ]),
        },
      },
      eventQueue: q,
    });

    return Effect.gen(function* () {
      const out = yield* releaseNotes.run(input);
      expect(out.published).toBe(false);
      expect(out.reason).toBe("rejected");
      expect(out.tag).toBe("v1.2.4"); // patch bump from v1.2.3
      expect(out.prNumber).toBeGreaterThan(0); // the PR was opened
      expect(handles.github.createReleaseCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("is a no-op when nothing has merged since the last tag", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        "git log": { exitCode: 0, stdout: gitOut("v1.2.3", "headsha", []) },
      },
    });

    return Effect.gen(function* () {
      const out = yield* releaseNotes.run(input);
      expect(out.published).toBe(false);
      expect(out.reason).toBe("no-changes");
      expect(out.tag).toBe("v1.2.3");
      expect(handles.github.createReleaseCalls).toHaveLength(0);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0); // never drafted
    }).pipe(Effect.provide(layer));
  });

  it.effect("times out (no approval) rather than publishing", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        "git log": {
          exitCode: 0,
          stdout: gitOut("", "headsha", [["sha1", "feat: x (#1)", "alice"]]),
        },
      },
      // empty event queue ⇒ the inline runner fails with ApprovalTimedOut
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(releaseNotes.run(input));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(handles.github.createReleaseCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});

describe("release-notes pure helpers", () => {
  it("nextVersion bumps per Conventional Commits", () => {
    const feat = [parseConventional({ sha: "a", subject: "feat: x", author: "" })];
    const fix = [parseConventional({ sha: "a", subject: "fix: x", author: "" })];
    const breaking = [
      parseConventional({ sha: "a", subject: "feat!: x", author: "" }),
    ];

    expect(nextVersion("", feat)).toBe("v0.1.0"); // first release
    expect(nextVersion("v1.2.3", fix)).toBe("v1.2.4");
    expect(nextVersion("v1.2.3", feat)).toBe("v1.3.0");
    expect(nextVersion("v1.2.3", breaking)).toBe("v2.0.0");
    expect(nextVersion("v0.3.1", feat)).toBe("v0.4.0");
    // Tolerates a bare (un-prefixed) tag.
    expect(nextVersion("2.0.0", fix)).toBe("v2.0.1");
  });

  it("bumpFor prefers the strongest signal present", () => {
    const conv = (s: string) =>
      parseConventional({ sha: "a", subject: s, author: "" });
    expect(bumpFor([conv("fix: a"), conv("chore: b")])).toBe("patch");
    expect(bumpFor([conv("fix: a"), conv("feat: b")])).toBe("minor");
    expect(bumpFor([conv("feat: a"), conv("fix!: b")])).toBe("major");
  });

  it("parseConventional reads type, breaking marker, and PR number", () => {
    const c = parseConventional({
      sha: "deadbeef",
      subject: "feat(api)!: overhaul auth (#42)",
      author: "dev",
    });
    expect(c.type).toBe("feat");
    expect(c.breaking).toBe(true);
    expect(c.pr).toBe(42);
    expect(c.description).toBe("overhaul auth");

    // BREAKING CHANGE in the subject also flags breaking.
    expect(
      parseConventional({ sha: "a", subject: "refactor: x BREAKING CHANGE", author: "" })
        .breaking,
    ).toBe(true);

    // A non-conventional subject falls back to type "other".
    const o = parseConventional({ sha: "a", subject: "random message", author: "x" });
    expect(o.type).toBe("other");
    expect(o.description).toBe("random message");
  });

  it("parseGitState splits HEAD / LASTTAG / COMMIT lines", () => {
    const state = parseGitState(
      gitOut("v1.0.0", "abc123", [["s1", "feat: a (#1)", "alice"]]),
    );
    expect(state.headSha).toBe("abc123");
    expect(state.lastTag).toBe("v1.0.0");
    expect(state.commits).toEqual([
      { sha: "s1", subject: "feat: a (#1)", author: "alice" },
    ]);
  });

  it("renderReleaseNotes categorizes, links PRs, and lists contributors", () => {
    const notes = renderReleaseNotes({
      repo: "fractalbox/flare-dispatch",
      tag: "v0.2.0",
      lastTag: "v0.1.0",
      date: "2026-06-22",
      raw: [
        { sha: "s1", subject: "feat: shiny (#10)", author: "alice" },
        { sha: "s2", subject: "fix: oops (#11)", author: "bob" },
        { sha: "s3", subject: "chore: tidy", author: "alice" },
        { sha: "s4", subject: "feat!: big break (#12)", author: "carol" },
      ],
    });

    expect(notes).toContain("## v0.2.0 (2026-06-22)");
    expect(notes).toContain("### ⚠️ Breaking changes");
    expect(notes).toContain("### 🚀 Features");
    expect(notes).toContain("### 🐛 Fixes");
    expect(notes).toContain("### 🧹 Other changes");
    // PR link + author attribution.
    expect(notes).toContain(
      "[#10](https://github.com/fractalbox/flare-dispatch/pull/10)",
    );
    expect(notes).toContain("— @alice");
    // Compare link between the tags.
    expect(notes).toContain("/compare/v0.1.0...v0.2.0");
    // Deduped contributors.
    expect(notes).toContain("**Contributors:** @alice, @bob, @carol");
  });

  it("renderReleaseNotes uses a commits link for the first release", () => {
    const notes = renderReleaseNotes({
      repo: "o/r",
      tag: "v0.1.0",
      lastTag: "",
      date: "2026-06-22",
      raw: [{ sha: "s1", subject: "feat: first (#1)", author: "alice" }],
    });
    expect(notes).toContain("the start of the project");
    expect(notes).toContain("/commits/v0.1.0");
  });
});
