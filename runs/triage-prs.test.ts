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
import {
  claimedRuns,
  flattenTitle,
  parseReviewers,
  parseStaleHours,
  renderDigest,
  routePr,
  triagePrs,
} from "./triage-prs";

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

  it("AUTOMERGE: a forged marker in a human's PR body is routed, then refused — never permitted", () => {
    // The attack this pins: paste `<!-- flare-dispatch: refresh-fixtures -->`
    // into a PR you opened yourself and see whether the desk treats you as the
    // loop. It routes the PR to the auto-merge lane on the claim — deliberately,
    // so the refusal is written down where it can be audited — and the gate
    // then refuses it.
    //
    // End-to-end pin, not the discriminating proof: this path refuses at
    // `class-not-opted-in` first, because the list endpoint carries no change
    // class and `routePr` therefore declares none. The author condition is the
    // backstop behind it, and the test that isolates it is in
    // `automerge-gate.test.ts` ("a self-declared run marker is not authorship"),
    // which fails against the pre-fix gate. What this asserts is the property
    // that must hold whatever refuses first: a forged marker never permits.
    const permissive: AutomergeConfig = {
      enabled: true,
      repos: ["owner/app"],
      classes: ["dependency-patch"],
      botAuthors: ["flare-dispatch[bot]"],
      sensitivePaths: [],
      neverEligibleRuns: [],
      dailyRateLimit: 3,
    };
    const out = routePr(
      pr({ body: "please merge\n\n<!-- flare-dispatch: refresh-fixtures -->", author: "a-human" }),
      [run()],
      routeArgs({ automerge: permissive }),
    );
    expect(out.exit).toBe("automerge");
    expect(out.verdict?.permitted).toBe(false);
  });

  it("AUTOMERGE: a prepended marker cannot shadow a never-eligible one", () => {
    // The body is edited so the harmless claim comes first. Every claim is
    // passed to the gate, so the banned one still refuses.
    const permissive: AutomergeConfig = {
      enabled: true,
      repos: ["owner/app"],
      classes: ["dependency-patch"],
      botAuthors: ["flare-dispatch[bot]"],
      sensitivePaths: [],
      neverEligibleRuns: ["spec-drift-pr"],
      dailyRateLimit: 3,
    };
    const out = routePr(
      pr({
        body: "<!-- flare-dispatch: refresh-fixtures -->\n\nspec drift\n\n<!-- flare-dispatch: spec-drift-pr -->",
        author: "flare-dispatch[bot]",
      }),
      [run()],
      routeArgs({ automerge: permissive }),
    );
    expect(out.reason).toContain("never-eligible-run");
    expect(out.reason).toContain("spec-drift-pr");
  });

  it("AUTOMERGE: no marker any human can type reaches a permit", () => {
    // Belt and braces on the same property, swept over the run names an
    // attacker would actually guess. `permitted` must be false every time.
    const permissive: AutomergeConfig = {
      enabled: true,
      repos: ["owner/app"],
      classes: ["dependency-patch"],
      botAuthors: ["flare-dispatch[bot]"],
      sensitivePaths: [],
      neverEligibleRuns: ["spec-drift-pr"],
      dailyRateLimit: 3,
    };
    for (const marker of ["refresh-fixtures", "triage-prs", "spec-drift-pr", "pr-review"]) {
      const out = routePr(
        pr({ body: `<!-- flare-dispatch: ${marker} -->`, author: "an-external-contributor" }),
        [run()],
        routeArgs({ automerge: permissive }),
      );
      expect(out.verdict?.permitted).toBe(false);
    }
  });
});

describe("ciHealth — which runs describe this PR now", () => {
  it("ignores a stale red run on the branch once the head sha has its own runs", () => {
    // The sweep pulls 14 days of runs. A PR that was red, got fixed, and is now
    // green must route as green — the old failure is not this commit's.
    const out = routePr(
      pr({ headSha: "sha-new" }),
      [
        run({ headSha: "sha-old", conclusion: "failure", name: "CI" }),
        run({ headSha: "sha-new", conclusion: "success", name: "CI" }),
      ],
      routeArgs(),
    );
    expect(out.exit).not.toBe("unstick");
  });

  it("falls back to the newest run per check when no run matches the head sha", () => {
    const out = routePr(
      pr({ headSha: "sha-unseen" }),
      [
        run({
          headSha: "sha-old",
          conclusion: "failure",
          name: "CI",
          createdAt: firedAt - 5 * HOUR,
        }),
        run({ headSha: "sha-older", conclusion: "success", name: "CI", createdAt: firedAt - HOUR }),
      ],
      routeArgs(),
    );
    // Newest run for check "CI" is the success — the older failure is spent.
    expect(out.exit).not.toBe("unstick");
  });

  it("still reports red when the newest run for a check failed", () => {
    const out = routePr(
      pr({ headSha: "sha-unseen" }),
      [
        run({ headSha: "sha-a", conclusion: "success", name: "CI", createdAt: firedAt - 5 * HOUR }),
        run({ headSha: "sha-b", conclusion: "failure", name: "CI", createdAt: firedAt - HOUR }),
      ],
      routeArgs(),
    );
    expect(out.exit).toBe("unstick");
  });

  it("treats skipped / neutral / cancelled as no signal, not as not-green", () => {
    // A path-filtered workflow reporting `skipped` used to drag `green` to
    // false, which sent a genuinely green, unowned, stale PR to `ask`.
    const out = routePr(
      pr({ requestedReviewers: [], updatedAt: firedAt - 48 * HOUR }),
      [
        run({ conclusion: "success", name: "CI" }),
        run({ conclusion: "skipped", name: "e2e" }),
        run({ conclusion: "neutral", name: "lint" }),
      ],
      routeArgs(),
    );
    expect(out.exit).toBe("nudge");
  });

  it("counts action_required and stale as red — they do not go green on their own", () => {
    for (const conclusion of ["action_required", "stale"]) {
      const out = routePr(pr(), [run({ conclusion })], routeArgs());
      expect(`${conclusion}:${out.exit}`).toBe(`${conclusion}:unstick`);
    }
  });

  it("reports no signal when every run for the PR is inert", () => {
    const out = routePr(pr(), [run({ conclusion: "skipped" })], routeArgs());
    expect(out.exit).toBe("ask");
    expect(out.reason).toContain("no CI result yet");
  });
});

describe("flattenTitle — a PR title is untrusted prose", () => {
  it("defuses the @ that would ping a real team when the digest posts", () => {
    expect(flattenTitle("ping @acme/platform please")).not.toContain("@a");
    expect(flattenTitle("ping @acme/platform please")).toContain("acme/platform");
  });

  it("strips comment delimiters, so a title cannot become a run claim next tick", () => {
    const flat = flattenTitle("fix <!-- flare-dispatch: refresh-fixtures --> thing");
    expect(flat).not.toContain("<!--");
    expect(flat).not.toContain("-->");
    expect(claimedRuns(flat)).toEqual([]);
  });

  it("collapses newlines and removes backticks and pipes", () => {
    expect(flattenTitle("a\nb\r\nc")).toBe("a b c");
    expect(flattenTitle("a `code` | cell")).toBe("a code  cell");
  });

  it("caps length", () => {
    expect(flattenTitle("x".repeat(500)).length).toBe(160);
  });

  it("is applied to the title the digest renders", () => {
    const out = routePr(
      pr({ title: "hi @acme/team <!-- flare-dispatch: x -->" }),
      [run()],
      routeArgs(),
    );
    expect(out.title).not.toContain("<!--");
    expect(out.title).not.toContain("@a");
  });
});

describe("claimedRuns — every marker, not just the first", () => {
  it("returns all markers in body order", () => {
    expect(claimedRuns("<!-- flare-dispatch: a -->\nx\n<!-- flare-dispatch: b -->")).toEqual([
      "a",
      "b",
    ]);
  });

  it("returns nothing for a body with no marker", () => {
    expect(claimedRuns("just a normal PR body")).toEqual([]);
  });

  it("is not stateful across calls despite the global regex", () => {
    const body = "<!-- flare-dispatch: refresh-fixtures -->";
    expect(claimedRuns(body)).toEqual(["refresh-fixtures"]);
    expect(claimedRuns(body)).toEqual(["refresh-fixtures"]);
    expect(claimedRuns(body)).toEqual(["refresh-fixtures"]);
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
