// Run-level unit tests for `triage-prs` — the four exits, and the digest that
// reports them. Driven against the in-memory test runtime with seeded config +
// github fakes. No CF, no network.

import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import type { PullRequestHistoryRef, WorkflowRunRef } from "@fractalboxdev/flare-dispatch-core";
import {
  AUTOMERGE_CONFIG_CLOSED,
  AUTOMERGE_CONFIG_PATH,
  type AutomergeConfig,
} from "@fractalboxdev/flare-dispatch-core/primitives";
import { parseReviewers, parseStaleHours, renderDigest, routePr, triagePrs } from "./triage-prs";

const firedAt = Date.UTC(2026, 7, 8);
const input = { firedAt } as const;
const HOUR = 3_600_000;

const pr = (over: Partial<PullRequestHistoryRef> = {}): PullRequestHistoryRef => ({
  repo: "owner/app",
  number: 42,
  title: "feat: a thing",
  body: "",
  headBranch: "feat/a-thing",
  headSha: "sha-42",
  state: "open",
  draft: false,
  labels: [],
  author: "a-human",
  requestedReviewers: ["@reviewer"],
  url: "https://github.com/owner/app/pull/42",
  createdAt: firedAt - 48 * HOUR,
  updatedAt: firedAt - 2 * HOUR,
  ...over,
});

const run = (over: Partial<WorkflowRunRef> = {}): WorkflowRunRef => ({
  repo: "owner/app",
  id: 1,
  name: "CI",
  headBranch: "feat/a-thing",
  headSha: "sha-42",
  status: "completed",
  conclusion: "success",
  url: "https://github.com/owner/app/actions/runs/1",
  createdAt: firedAt - HOUR,
  ...over,
});

const routeArgs = (over: Partial<Parameters<typeof routePr>[2]> = {}) => ({
  staleHours: 24,
  flakyChecks: ["flaky-e2e"],
  automerge: AUTOMERGE_CONFIG_CLOSED,
  nowMs: firedAt,
  ...over,
});

describe("routePr — the four exits", () => {
  it("ASK: green, reviewer requested, nothing mechanical to do", () => {
    const out = routePr(pr(), [run()], routeArgs());
    expect(out.exit).toBe("ask");
    expect(out.reason).toContain("still want to land");
  });

  it("ASK: no CI result at all — the honest answer is a question", () => {
    const out = routePr(pr(), [], routeArgs());
    expect(out.exit).toBe("ask");
    expect(out.reason).toContain("no CI result");
  });

  it("NUDGE: green, nobody requested, older than the stale window", () => {
    const out = routePr(
      pr({ requestedReviewers: [], updatedAt: firedAt - 30 * HOUR }),
      [run()],
      routeArgs(),
    );
    expect(out.exit).toBe("nudge");
    expect(out.reason).toContain("30h");
  });

  it("NUDGE does not fire inside the stale window", () => {
    const out = routePr(
      pr({ requestedReviewers: [], updatedAt: firedAt - 2 * HOUR }),
      [run()],
      routeArgs(),
    );
    expect(out.exit).toBe("ask");
  });

  it("UNSTICK: red CI, and it names the failing check", () => {
    const out = routePr(pr(), [run({ name: "check", conclusion: "failure" })], routeArgs());
    expect(out.exit).toBe("unstick");
    expect(out.reason).toContain("`check` is red");
  });

  it("UNSTICK: a known-flaky check says so, so the fix is a re-run", () => {
    const out = routePr(pr(), [run({ name: "flaky-e2e", conclusion: "failure" })], routeArgs());
    expect(out.exit).toBe("unstick");
    expect(out.reason).toContain("known-flaky");
  });

  it("UNSTICK outranks NUDGE — a red PR is not waiting on a reviewer", () => {
    const out = routePr(
      pr({ requestedReviewers: [], updatedAt: firedAt - 30 * HOUR }),
      [run({ conclusion: "failure" })],
      routeArgs(),
    );
    expect(out.exit).toBe("unstick");
  });

  it("AUTOMERGE: a loop-authored PR reaches the gate and its refusal is recorded", () => {
    const out = routePr(
      pr({ body: "<!-- flare-dispatch: refresh-fixtures -->", author: "flare-dispatch[bot]" }),
      [run()],
      routeArgs(),
    );
    expect(out.exit).toBe("automerge");
    expect(out.verdict?.permitted).toBe(false);
    expect(out.reason).toContain("refused: disabled");
  });

  it("AUTOMERGE: a never-eligible run is refused by name, not by the config being off", () => {
    const permissive: AutomergeConfig = {
      enabled: true,
      repos: ["owner/app"],
      classes: ["inert-prose-only"],
      botAuthors: [],
      sensitivePaths: ["specs/"],
      neverEligibleRuns: ["spec-drift-pr"],
      dailyRateLimit: 3,
    };
    const out = routePr(
      pr({ body: "<!-- flare-dispatch: spec-drift-pr -->" }),
      [run()],
      routeArgs({ automerge: permissive }),
    );
    expect(out.reason).toContain("never-eligible-run");
  });

  it("AUTOMERGE: an undeclared change class refuses before paths are even asked about", () => {
    // The list endpoint carries no diff, so `changedPaths` is empty — which must
    // never read as "a clean diff".
    const permissive: AutomergeConfig = {
      enabled: true,
      repos: ["owner/app"],
      classes: ["dependency-patch"],
      botAuthors: [],
      sensitivePaths: [],
      neverEligibleRuns: [],
      dailyRateLimit: 3,
    };
    const out = routePr(
      pr({ body: "<!-- flare-dispatch: refresh-fixtures -->" }),
      [run()],
      routeArgs({ automerge: permissive }),
    );
    expect(out.reason).toContain("class-not-opted-in");
  });
});

describe("triage-prs — the run", () => {
  const baseConfig = {
    "triage-prs.repos": "owner/app",
    "triage-prs.control-repo": "owner/control",
    "triage-prs.reviewers": "owner/app=@ada",
  };

  it.effect("is a no-op when the estate is unset", () => {
    const { layer, handles } = makeCFRuntimeTest({ config: {} });
    return Effect.gen(function* () {
      const out = yield* triagePrs.run(input);
      expect(out.reposSwept).toBe(0);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stays silent when there are no open PRs to route", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      github: { now: firedAt, pullRequestHistory: [] },
    });
    return Effect.gen(function* () {
      const out = yield* triagePrs.run(input);
      expect(out.prsRouted).toBe(0);
      expect(out.prOpened).toBe(false);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips drafts — an unfinished PR is not waiting on anyone", () => {
    const { layer } = makeCFRuntimeTest({
      config: baseConfig,
      github: { now: firedAt, pullRequestHistory: [pr({ draft: true })] },
    });
    return Effect.gen(function* () {
      const out = yield* triagePrs.run(input);
      expect(out.prsRouted).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  // Same rule as `org-spec-audit`: no default control repo, because a default
  // is a repository somebody else's deployment files pull requests against.
  it.effect("fails when no control repo is configured, before reading anything", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: { "triage-prs.repos": "owner/app", "triage-prs.reviewers": "owner/app=@ada" },
      github: { now: firedAt, pullRequestHistory: [pr()], workflowRuns: [run()] },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(triagePrs.run(input));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("triage-prs.control-repo");
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
      expect(handles.github.readTextFileCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes and reads where config says, not where the run was born", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: {
        ...baseConfig,
        "triage-prs.digest-dir": "infra/loop/triage/",
        "triage-prs.automerge-path": "infra/loop/automerge.json",
      },
      github: {
        now: firedAt,
        pullRequestHistory: [pr()],
        workflowRuns: [run()],
        files: { "owner/control:infra/loop/automerge.json": '{"enabled":false}' },
      },
    });

    return Effect.gen(function* () {
      yield* triagePrs.run(input);
      const call = handles.github.openDraftPullRequestCalls[0]!;
      expect(call.files[0]!.path).toBe("infra/loop/triage/2026-08-08.md");
      // The allowlist came from the configured path. Asserted on the read, not
      // on the verdict: an unreadable config also refuses, so a verdict-only
      // assertion would pass whether or not the path was honoured.
      expect(handles.github.readTextFileCalls.map((c) => c.path)).toContain(
        "infra/loop/automerge.json",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a digest-dir that escapes the repo root", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: { ...baseConfig, "triage-prs.digest-dir": "../../etc" },
      github: { now: firedAt, pullRequestHistory: [pr()], workflowRuns: [run()] },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(triagePrs.run(input));
      expect(exit._tag).toBe("Failure");
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("opens one digest naming each exit, and merges nothing", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      github: {
        now: firedAt,
        pullRequestHistory: [
          pr({ number: 1 }),
          pr({ number: 2, requestedReviewers: [], updatedAt: firedAt - 30 * HOUR }),
          pr({ number: 3, headSha: "sha-3", headBranch: "feat/red" }),
          pr({ number: 4, body: "<!-- flare-dispatch: refresh-fixtures -->" }),
        ],
        workflowRuns: [
          run(),
          run({ id: 2, headSha: "sha-3", headBranch: "feat/red", conclusion: "failure" }),
        ],
        files: { [`owner/control:${AUTOMERGE_CONFIG_PATH}`]: '{"enabled":false}' },
      },
    });

    return Effect.gen(function* () {
      const out = yield* triagePrs.run(input);
      expect(out.prsRouted).toBe(4);
      expect(out.nudge).toBe(1);
      expect(out.unstick).toBe(1);
      expect(out.automergeConsidered).toBe(1);
      expect(out.automergePermitted).toBe(0);
      expect(out.prOpened).toBe(true);

      const call = handles.github.openDraftPullRequestCalls[0]!;
      expect(call.repo).toBe("owner/control");
      expect(call.headBranch).toBe("flare-dispatch/triage-digest-2026-08-08");
      expect(call.files[0]!.path).toBe("maintenance/triage/2026-08-08.md");
      // The auto-merge section must never read as though anything merged.
      expect(call.files[0]!.content).toContain("Nothing here was merged");
      expect(call.files[0]!.content).toContain("reviewer of record: @ada");
      expect(call.body).toContain("maintenance-key: triage-prs/owner/app#1-ask");
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses every auto-merge when the allowlist cannot be read", () => {
    // No `files` seed ⇒ the fake answers `found: false` ⇒ the closed config.
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      github: {
        now: firedAt,
        pullRequestHistory: [pr({ body: "<!-- flare-dispatch: refresh-fixtures -->" })],
        workflowRuns: [run()],
      },
    });

    return Effect.gen(function* () {
      const out = yield* triagePrs.run(input);
      expect(out.automergeConsidered).toBe(1);
      expect(out.automergePermitted).toBe(0);
      expect(
        handles.io.logs.some((l) => l.level === "warn" && l.msg.includes("refusing every")),
      ).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("drops a suppressed line and says how many, in body and digest", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      github: {
        now: firedAt,
        pullRequestHistory: [pr({ number: 1 }), pr({ number: 2 })],
        workflowRuns: [run()],
        files: {
          "owner/control:maintenance/declined.jsonl": JSON.stringify({
            key: "triage-prs/owner/app#1-ask",
            reason: "that PR is parked on purpose",
            by: "@ada",
            at: "2026-08-01",
          }),
        },
      },
    });

    return Effect.gen(function* () {
      const out = yield* triagePrs.run(input);
      expect(out.digestSuppressed).toBe(1);
      expect(out.prsRouted).toBe(1);
      const call = handles.github.openDraftPullRequestCalls[0]!;
      expect(call.body).toContain("**Suppressed: 1**");
      expect(call.files[0]!.content).toContain("that PR is parked on purpose");
    }).pipe(Effect.provide(layer));
  });

  it("declares no cron — arming the desk is a product decision", () => {
    expect(triagePrs.schedules).toBeUndefined();
  });
});

describe("config parsing", () => {
  it("defaults stale-hours on nonsense and takes a positive integer", () => {
    expect(parseStaleHours(undefined)).toBe(24);
    expect(parseStaleHours("0")).toBe(24);
    expect(parseStaleHours("-4")).toBe(24);
    expect(parseStaleHours("48")).toBe(48);
  });

  it("parses reviewer-of-record pairs and skips malformed entries", () => {
    const out = parseReviewers("owner/a=@ada owner/b=@bo bad-entry owner/c=");
    expect(out.get("owner/a")).toBe("@ada");
    expect(out.get("owner/b")).toBe("@bo");
    expect(out.has("bad-entry")).toBe(false);
    expect(out.has("owner/c")).toBe(false);
  });
});

describe("renderDigest", () => {
  const routed = [
    {
      repo: "owner/app",
      number: 7,
      title: "chore: bump",
      url: "https://github.com/owner/app/pull/7",
      author: "a-human",
      exit: "nudge" as const,
      reason: "green for 30h with no reviewer requested",
    },
  ];

  it("names the reviewer of record, and says so when there isn't one", () => {
    const withReviewer = renderDigest({
      day: "2026-08-08",
      routed,
      reviewers: new Map([["owner/app", "@ada"]]),
      suppression: { allowed: [], suppressed: [], degraded: [] },
    });
    expect(withReviewer).toContain("reviewer of record: @ada");

    const without = renderDigest({
      day: "2026-08-08",
      routed,
      reviewers: new Map(),
      suppression: { allowed: [], suppressed: [], degraded: [] },
    });
    expect(without).toContain("no reviewer of record recorded");
  });
});
