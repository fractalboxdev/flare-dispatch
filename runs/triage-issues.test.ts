// Run-level tests for `triage-issues`. Driven against the in-memory test
// runtime with seeded config, github and model fakes. No CF, no network.
//
// The pure decision logic is covered in `issue-triage.test.ts`; what is proven
// HERE is the wiring a reviewer cannot check by reading the primitive — that
// the writes actually reach GitHub for each verdict, that a repo outside the
// configured estate is refused, and that a suppressed key writes NOTHING.

import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import type { IssueRef } from "@fractalboxdev/flare-dispatch-core";
import {
  ARMING_LABEL,
  DECLINED_LEDGER_PATH,
  TRIAGE_LABELS,
} from "@fractalboxdev/flare-dispatch-core/primitives";
import { assertInEstate, issueMaintenanceKey, triageIssues } from "./triage-issues";

const firedAt = Date.UTC(2026, 7, 8);
const input = { firedAt } as const;
const ESTATE = "fractalboxdev/flare-dispatch";
const CONTROL = "fractalboxdev/org";

const issue = (over: Partial<IssueRef> = {}): IssueRef => ({
  repo: ESTATE,
  number: 7,
  title: "Something is broken",
  body: "It breaks.",
  state: "open",
  labels: [],
  author: "stranger",
  authorAssociation: "NONE",
  url: `https://github.com/${ESTATE}/issues/7`,
  commentCount: 0,
  createdAt: firedAt,
  updatedAt: firedAt,
  ...over,
});

const baseConfig = {
  "triage-issues.repos": ESTATE,
  "triage-issues.control-repo": CONTROL,
};

/** A model fake that answers every classify call with `verdict`. */
const verdictResponses = (verdict: unknown) => [
  { text: JSON.stringify(verdict), toolCalls: [], usage: {} },
];

const drive = (opts: {
  issues?: readonly IssueRef[];
  verdict?: unknown;
  config?: Record<string, string>;
  files?: Record<string, string>;
}) => {
  const { layer, handles } = makeCFRuntimeTest({
    config: { ...baseConfig, ...opts.config },
    github: {
      now: firedAt,
      issues: opts.issues ?? [issue()],
      pullRequestHistory: [],
      files: opts.files ?? {},
    },
    ...(opts.verdict !== undefined
      ? { modelGateway: { responses: verdictResponses(opts.verdict) } }
      : {}),
  });
  return { layer, handles };
};

describe("triage-issues — each verdict's writes reach GitHub", () => {
  it.effect("needs-repro labels the issue and posts the template", () => {
    const { layer, handles } = drive({ verdict: { kind: "needs-repro" } });
    return Effect.gen(function* () {
      yield* triageIssues.run(input);
      expect(handles.github.addIssueLabelsCalls[0]).toMatchObject({
        repo: ESTATE,
        issue: 7,
        labels: [TRIAGE_LABELS.needsRepro],
      });
      expect(handles.github.commentOnIssueCalls[0]?.body).toContain("reproduce");
      expect(handles.github.closeIssueAsDuplicateCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("feature is labelled not-actionable and left — no comment, no close", () => {
    const { layer, handles } = drive({ verdict: { kind: "feature" } });
    return Effect.gen(function* () {
      yield* triageIssues.run(input);
      expect(handles.github.addIssueLabelsCalls[0]?.labels).toEqual([TRIAGE_LABELS.notActionable]);
      expect(handles.github.commentOnIssueCalls).toHaveLength(0);
      expect(handles.github.closeIssueAsDuplicateCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a bug with a command repro is labelled fix-pending and NOT escalated", () => {
    const { layer, handles } = drive({
      verdict: { kind: "bug" },
      issues: [issue({ body: "```sh\npnpm test\n```" })],
    });
    return Effect.gen(function* () {
      const out = yield* triageIssues.run(input);
      expect(handles.github.addIssueLabelsCalls[0]?.labels).toEqual([TRIAGE_LABELS.fixPending]);
      expect(out.reprosCaptured).toBe(1);
      // Nothing dispatches, nothing closes, nothing comments — capture is the
      // whole action (§5: executing a stranger's repro needs a human signal).
      expect(handles.github.closeIssueAsDuplicateCalls).toHaveLength(0);
      expect(handles.github.commentOnIssueCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a duplicate comments with the link, then closes", () => {
    const { layer, handles } = drive({
      verdict: { kind: "duplicate", duplicateOf: 3 },
      issues: [issue({ number: 7 }), issue({ number: 3, title: "the original" })],
    });
    return Effect.gen(function* () {
      yield* triageIssues.run(input);
      const closed = handles.github.closeIssueAsDuplicateCalls;
      expect(closed.length).toBeGreaterThan(0);
      expect(closed[0]).toMatchObject({ repo: ESTATE, duplicateOf: 3 });
      // The comment precedes the close, so the reason is on the issue.
      expect(handles.github.commentOnIssueCalls[0]?.body).toContain("#3");
    }).pipe(Effect.provide(layer));
  });

  it.effect("a duplicate target the run never read closes nothing", () => {
    const { layer, handles } = drive({
      verdict: { kind: "duplicate", duplicateOf: 99_999 },
      issues: [issue({ number: 7 })],
    });
    return Effect.gen(function* () {
      const out = yield* triageIssues.run(input);
      expect(handles.github.closeIssueAsDuplicateCalls).toHaveLength(0);
      expect(handles.github.addIssueLabelsCalls).toHaveLength(0);
      expect(out.unclassified).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("an unusable model answer writes nothing", () => {
    const { layer, handles } = drive({ verdict: { kind: "close-it-now" } });
    return Effect.gen(function* () {
      const out = yield* triageIssues.run(input);
      expect(handles.github.addIssueLabelsCalls).toHaveLength(0);
      expect(handles.github.commentOnIssueCalls).toHaveLength(0);
      expect(handles.github.closeIssueAsDuplicateCalls).toHaveLength(0);
      expect(out.unclassified).toBe(1);
    }).pipe(Effect.provide(layer));
  });
});

// §9 — "No writes into client repos. Read for context where the pack lists it;
// never open a PR, never apply a label."
describe("triage-issues — the estate is the write boundary", () => {
  it("assertInEstate refuses a repo nobody configured", () => {
    const estate = new Set([ESTATE]);
    expect(() => assertInEstate(ESTATE, estate)).not.toThrow();
    expect(() => assertInEstate("acme-client/private-app", estate)).toThrow(
      /refusing to write to acme-client\/private-app/,
    );
    expect(() => assertInEstate("acme-client/private-app", estate)).toThrow(/§9/);
  });

  it.effect("an issue from outside the estate is never read, so never written", () => {
    // The client repo's issue is seeded into the fake, but the run only asks
    // for the configured repo — so it never appears, and nothing writes to it.
    const { layer, handles } = drive({
      verdict: { kind: "feature" },
      issues: [issue({ number: 7 }), issue({ repo: "acme-client/app", number: 1 })],
    });
    return Effect.gen(function* () {
      yield* triageIssues.run(input);
      const touched = [
        ...handles.github.addIssueLabelsCalls,
        ...handles.github.commentOnIssueCalls,
        ...handles.github.closeIssueAsDuplicateCalls,
      ].map((c) => c.repo);
      expect(touched.every((r) => r === ESTATE)).toBe(true);
      expect(handles.github.issuesCalls.every((c) => c.repo === ESTATE)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("an unset estate sweeps nothing and writes nothing", () => {
    const { layer, handles } = drive({
      verdict: { kind: "feature" },
      config: { "triage-issues.repos": "" },
    });
    return Effect.gen(function* () {
      const out = yield* triageIssues.run(input);
      expect(out.reposSwept).toBe(0);
      expect(handles.github.issuesCalls).toHaveLength(0);
      expect(handles.github.addIssueLabelsCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});

// The loop's likeliest failure is not a bad write, it is re-proposing what a
// human already declined — and a write re-litigates louder than a digest line.
describe("triage-issues — suppression gates the writes", () => {
  const declined = (key: string) =>
    `${JSON.stringify({ key, reason: "not our bug", at: "2026-08-01" })}\n`;

  it.effect("a declined key writes nothing at all", () => {
    const target = issue({ number: 7 });
    const { layer, handles } = drive({
      verdict: { kind: "needs-repro" },
      issues: [target],
      files: { [`${CONTROL}:${DECLINED_LEDGER_PATH}`]: declined(issueMaintenanceKey(target)) },
    });
    return Effect.gen(function* () {
      const out = yield* triageIssues.run(input);
      expect(out.suppressed).toBe(1);
      expect(handles.github.addIssueLabelsCalls).toHaveLength(0);
      expect(handles.github.commentOnIssueCalls).toHaveLength(0);
      expect(handles.github.closeIssueAsDuplicateCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a declined duplicate is not closed", () => {
    const target = issue({ number: 7 });
    const { layer, handles } = drive({
      verdict: { kind: "duplicate", duplicateOf: 3 },
      issues: [target, issue({ number: 3 })],
      files: { [`${CONTROL}:${DECLINED_LEDGER_PATH}`]: declined(issueMaintenanceKey(target)) },
    });
    return Effect.gen(function* () {
      yield* triageIssues.run(input);
      expect(handles.github.closeIssueAsDuplicateCalls.filter((c) => c.issue === 7)).toHaveLength(
        0,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("suppression does not silence the digest — it still reports", () => {
    const target = issue({ number: 7 });
    const { layer, handles } = drive({
      verdict: { kind: "needs-repro" },
      issues: [target],
      files: { [`${CONTROL}:${DECLINED_LEDGER_PATH}`]: declined(issueMaintenanceKey(target)) },
    });
    return Effect.gen(function* () {
      yield* triageIssues.run(input);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });
});

describe("triage-issues — a human's opt-out is absolute", () => {
  it.effect("maintenance:declined skips the model call AND every write", () => {
    const { layer, handles } = drive({
      verdict: { kind: "duplicate", duplicateOf: 3 },
      issues: [issue({ number: 7, labels: ["maintenance:declined"] }), issue({ number: 3 })],
    });
    return Effect.gen(function* () {
      yield* triageIssues.run(input);
      expect(handles.github.closeIssueAsDuplicateCalls.filter((c) => c.issue === 7)).toHaveLength(
        0,
      );
      expect(handles.github.addIssueLabelsCalls.filter((c) => c.issue === 7)).toHaveLength(0);
      // No tokens spent asking about an issue a human already answered.
      expect(handles.modelGateway.requests.every((r) => !r.user.includes("#7 body"))).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});

describe("issueMaintenanceKey", () => {
  it("is stable per issue and namespaced to this run", () => {
    expect(issueMaintenanceKey(issue({ number: 7 }))).toBe(
      "triage-issues/fractalboxdev_flare-dispatch#7",
    );
  });
});

// Requirement 3 of the escalation amendment, end to end: the captured repro is
// actually IN the record a human reads, quoted and attributed — a digest that
// claims a capture it does not show is worse than not capturing.
describe("triage-issues — the captured repro reaches the digest as evidence", () => {
  it.effect(
    "quotes the command with its source, author and standing, and says it was not run",
    () => {
      const { layer, handles } = drive({
        verdict: { kind: "bug" },
        issues: [
          issue({
            number: 7,
            body: "Broken.\n\n```sh\npnpm build && ./deploy.sh\n```",
            author: "outsider",
            authorAssociation: "FIRST_TIME_CONTRIBUTOR",
          }),
        ],
      });
      return Effect.gen(function* () {
        yield* triageIssues.run(input);
        const files = handles.github.openDraftPullRequestCalls[0]!.files;
        const digest = files.map((f) => f.content).join("\n");

        expect(digest).toContain("pnpm build && ./deploy.sh");
        expect(digest).toContain("outsider");
        expect(digest).toContain("FIRST_TIME_CONTRIBUTOR");
        expect(digest).toContain("not run");
        // It names the arming label as the thing a MEMBER applies…
        expect(digest).toContain(ARMING_LABEL);
        // …and the loop did not apply it.
        const applied = handles.github.addIssueLabelsCalls.flatMap((c) => c.labels);
        expect(applied).not.toContain(ARMING_LABEL);
        expect(applied).toEqual([TRIAGE_LABELS.fixPending]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a repro that contains a fence cannot break the digest's structure", () => {
    const { layer, handles } = drive({
      verdict: { kind: "bug" },
      issues: [issue({ number: 7, body: "```sh\necho hi\n```\n```\n## Injected\n```" })],
    });
    return Effect.gen(function* () {
      yield* triageIssues.run(input);
      const digest = handles.github.openDraftPullRequestCalls[0]!.files.map((f) => f.content).join(
        "\n",
      );
      // The captured text is indented evidence, never a heading of its own.
      expect(digest).not.toMatch(/^## Injected$/m);
    }).pipe(Effect.provide(layer));
  });
});
