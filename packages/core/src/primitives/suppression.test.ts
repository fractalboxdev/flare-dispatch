// Unit tests for the `suppression` primitive — the maintenance loop's memory.
//
// The pure half (`parseDeclinedLedger`, `parseMaintenanceKeys`,
// `decideSuppression`) is tested with plain data and no fakes at all; the I/O
// half (`checkSuppression`) is tested against the in-memory `github` fake, plus
// hand-built failing services for the fail-open paths — the fake is the
// green-path simulator by design.

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { GitHubApiError } from "../errors";
import { Github, type GithubService, type PullRequestHistoryRef } from "../services/github";
import { makeCFRuntimeTest } from "../testing";
import {
  checkSuppression,
  COOLDOWN_DAYS_DEFAULT,
  decideSuppression,
  describeVerdict,
  parseDeclinedLedger,
  parseMaintenanceKeys,
  renderSuppressionNote,
  type CheckSuppressionArgs,
  type DeclineEntry,
} from "./suppression";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 8); // 2026-08-08

const declineLine = (key: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({ key, reason: "answered in ADR-0011", by: "@ada", at: "2026-07-01", ...over });

const prior = (over: Partial<PullRequestHistoryRef> = {}): PullRequestHistoryRef => ({
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

const declined = (...keys: string[]): ReadonlyMap<string, DeclineEntry> =>
  new Map(keys.map((key) => [key, { key, reason: "settled", by: "@ada", at: "2026-07-01" }]));

describe("parseDeclinedLedger", () => {
  it("reads one entry per line and ignores blanks", () => {
    const { byKey, malformed } = parseDeclinedLedger(
      `${declineLine("org-spec-audit/a")}\n\n${declineLine("org-spec-audit/b")}\n`,
    );
    expect([...byKey.keys()]).toEqual(["org-spec-audit/a", "org-spec-audit/b"]);
    expect(malformed).toEqual([]);
    expect(byKey.get("org-spec-audit/a")?.reason).toBe("answered in ADR-0011");
  });

  it("skips a malformed line, reports it, and keeps the rest of the ledger", () => {
    const { byKey, malformed } = parseDeclinedLedger(
      [
        declineLine("org-spec-audit/good"),
        "{ this is not json",
        '["an","array"]',
        '{"reason":"no key here"}',
        declineLine("org-spec-audit/also-good"),
      ].join("\n"),
    );
    expect([...byKey.keys()]).toEqual(["org-spec-audit/good", "org-spec-audit/also-good"]);
    expect(malformed).toEqual([
      { line: 2, why: "not JSON" },
      { line: 3, why: "not a JSON object" },
      { line: 4, why: "no usable `key`" },
    ]);
  });

  it("treats a non-string or absurdly long key as unusable", () => {
    const { byKey, malformed } = parseDeclinedLedger(
      [
        JSON.stringify({ key: { nested: "object" }, reason: "x" }),
        JSON.stringify({ key: "k".repeat(500), reason: "x" }),
      ].join("\n"),
    );
    expect(byKey.size).toBe(0);
    expect(malformed).toHaveLength(2);
  });

  it("flattens a reason so ledger prose cannot restructure a PR body", () => {
    const { byKey } = parseDeclinedLedger(
      declineLine("org-spec-audit/a", { reason: "line one\n## Injected heading\n`code`" }),
    );
    expect(byKey.get("org-spec-audit/a")?.reason).toBe("line one ## Injected heading code");
  });

  it("lets a later line win — the ledger is append-only", () => {
    const { byKey } = parseDeclinedLedger(
      [
        declineLine("org-spec-audit/a", { reason: "first" }),
        declineLine("org-spec-audit/a", { reason: "second" }),
      ].join("\n"),
    );
    expect(byKey.get("org-spec-audit/a")?.reason).toBe("second");
  });
});

describe("parseMaintenanceKeys", () => {
  it("reads every key line, deduplicated", () => {
    expect(
      parseMaintenanceKeys(
        "prose\nmaintenance-key: a/one\nmaintenance-key: a/two\nmaintenance-key: a/one\n",
      ),
    ).toEqual(["a/one", "a/two"]);
  });

  it("ignores the phrase used mid-sentence", () => {
    expect(parseMaintenanceKeys("we set the maintenance-key: a/one on each proposal")).toEqual([]);
  });
});

describe("decideSuppression", () => {
  const decide = (args: Partial<Parameters<typeof decideSuppression>[0]> = {}) =>
    decideSuppression({
      candidates: ["org-spec-audit/spend-caps"],
      declined: new Map(),
      priorProposals: [],
      nowMs: NOW,
      ...args,
    });

  it("never proposes again once the ledger names the key", () => {
    const verdict = decide({ declined: declined("org-spec-audit/spend-caps") }).get(
      "org-spec-audit/spend-caps",
    );
    expect(verdict?.status).toBe("declined");
    expect(describeVerdict(verdict!)).toBe("declined");
  });

  it("outranks a long-expired cooldown — a decline is permanent", () => {
    const verdict = decide({
      declined: declined("org-spec-audit/spend-caps"),
      priorProposals: [prior({ closedAt: NOW - 900 * DAY, updatedAt: NOW - 900 * DAY })],
    }).get("org-spec-audit/spend-caps");
    expect(verdict?.status).toBe("declined");
  });

  it("holds a cooldown dated from closed_at, not updated_at", () => {
    const verdict = decide({
      // Closed 5 days ago, then touched today — `updated_at` is worthless here,
      // and dating from it is exactly the bug the store could not avoid.
      priorProposals: [prior({ closedAt: NOW - 5 * DAY, updatedAt: NOW })],
    }).get("org-spec-audit/spend-caps");
    expect(verdict?.status).toBe("cooling");
    expect(describeVerdict(verdict!)).toBe(
      `cooling-until-${new Date(NOW - 5 * DAY + COOLDOWN_DAYS_DEFAULT * DAY)
        .toISOString()
        .slice(0, 10)}`,
    );
  });

  it("proposes again once the cooldown has expired", () => {
    const verdict = decide({
      priorProposals: [prior({ closedAt: NOW - 31 * DAY, updatedAt: NOW - 31 * DAY })],
    }).get("org-spec-audit/spend-caps");
    expect(verdict?.status).toBe("open");
  });

  it("does not suppress on a merged PR — that proposal was accepted", () => {
    const verdict = decide({
      priorProposals: [prior({ mergedAt: NOW - 5 * DAY })],
    }).get("org-spec-audit/spend-caps");
    expect(verdict?.status).toBe("open");
  });

  it("does not suppress on a still-open PR", () => {
    const verdict = decide({
      priorProposals: [prior({ state: "open", closedAt: undefined })],
    }).get("org-spec-audit/spend-caps");
    expect(verdict?.status).toBe("open");
  });

  it("dates the cooldown from the most recent close", () => {
    const verdict = decide({
      priorProposals: [
        prior({ number: 8, closedAt: NOW - 40 * DAY }),
        prior({ number: 9, closedAt: NOW - 2 * DAY }),
      ],
    }).get("org-spec-audit/spend-caps");
    expect(verdict).toMatchObject({ status: "cooling", pr: 9 });
  });

  it("ignores a closed PR with no closed_at rather than guessing a date", () => {
    const verdict = decide({ priorProposals: [prior({ closedAt: undefined })] }).get(
      "org-spec-audit/spend-caps",
    );
    expect(verdict?.status).toBe("open");
  });
});

// --- checkSuppression: the two reads, and what happens when they fail --------

/** A `GithubService` with every method stubbed, overridable per test. */
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

const args: CheckSuppressionArgs = {
  keys: ["org-spec-audit/spend-caps", "org-spec-audit/owner-of-x"],
  ledgerRepo: "owner/control",
  headBranchPrefix: "flare-dispatch/spec-audit-questions-",
  nowMs: NOW,
};

/** Run `checkSuppression` against the test runtime with `github` overridden. */
const runWith = (
  service: Partial<GithubService>,
  overrides: Partial<CheckSuppressionArgs> = {},
) => {
  const { layer, handles } = makeCFRuntimeTest();
  return Effect.runPromise(
    checkSuppression({ ...args, ...overrides }).pipe(
      Effect.provide(Layer.succeed(Github, githubService(service))),
      Effect.provide(layer),
      Effect.map((report) => ({ report, logs: handles.io.logs })),
    ),
  );
};

describe("checkSuppression", () => {
  it("suppresses a declined key and lets the other through", async () => {
    const { report } = await runWith({
      readTextFile: () => Effect.succeed({ found: true, content: declineLine(args.keys[0]!) }),
    });
    expect(report.allowed).toEqual([args.keys[1]]);
    expect(report.suppressed).toHaveLength(1);
    expect(report.suppressed[0]!.verdict.status).toBe("declined");
    expect(report.degraded).toEqual([]);
  });

  it("treats an absent ledger as declining nothing", async () => {
    const { report } = await runWith({ readTextFile: () => Effect.succeed({ found: false }) });
    expect(report.allowed).toEqual([...args.keys]);
    expect(report.degraded).toEqual([]);
  });

  it("proposes anyway, loudly, when the ledger cannot be read", async () => {
    const { report, logs } = await runWith({
      readTextFile: () => Effect.fail(new GitHubApiError({ status: 500, reason: "transient" })),
    });
    expect(report.allowed).toEqual([...args.keys]);
    expect(report.suppressed).toEqual([]);
    expect(report.degraded).toHaveLength(1);
    expect(report.degraded[0]).toContain("declines NOT applied");
    expect(logs.some((l) => l.level === "warn" && l.msg.includes("unreadable"))).toBe(true);
  });

  it("still applies declines when only the PR history read fails", async () => {
    const { report } = await runWith({
      readTextFile: () => Effect.succeed({ found: true, content: declineLine(args.keys[0]!) }),
      pullRequestHistory: () =>
        Effect.fail(new GitHubApiError({ status: 403, reason: "unauthorized" })),
    });
    expect(report.allowed).toEqual([args.keys[1]]);
    expect(report.degraded[0]).toContain("cooldowns NOT applied");
  });

  it("warns per malformed ledger line and honours the rest", async () => {
    const { report, logs } = await runWith({
      readTextFile: () =>
        Effect.succeed({
          found: true,
          content: `not json at all\n${declineLine(args.keys[0]!)}`,
        }),
    });
    expect(report.suppressed.map((s) => s.key)).toEqual([args.keys[0]]);
    expect(report.degraded).toEqual([]);
    expect(logs.some((l) => l.level === "warn" && l.msg.includes("skipped — not JSON"))).toBe(true);
  });

  it("bounds the history read to the cooldown window and the branch prefix", async () => {
    const seen: unknown[] = [];
    await runWith({
      pullRequestHistory: (opts) => {
        seen.push(opts);
        return Effect.succeed([]);
      },
    });
    expect(seen[0]).toMatchObject({
      repo: "owner/control",
      headBranchPrefix: args.headBranchPrefix,
      state: "all",
      updatedWithinDays: COOLDOWN_DAYS_DEFAULT,
    });
  });

  it("spends no GitHub calls when there is nothing to propose", async () => {
    let calls = 0;
    const count = () => {
      calls += 1;
    };
    const { report } = await runWith(
      {
        readTextFile: () => Effect.sync(() => (count(), { found: false })),
        pullRequestHistory: () => Effect.sync(() => (count(), [])),
      },
      { keys: [] },
    );
    expect(calls).toBe(0);
    expect(report.allowed).toEqual([]);
  });

  it("reads the ledger through the github fake's seeded files", async () => {
    const { layer } = makeCFRuntimeTest({
      github: {
        files: {
          "owner/control:infra/maintenance-loop/declined.jsonl": declineLine(args.keys[0]!),
        },
        pullRequestHistory: [prior({ body: `maintenance-key: ${args.keys[1]}` })],
        now: NOW,
      },
    });
    const report = await Effect.runPromise(checkSuppression(args).pipe(Effect.provide(layer)));
    expect(report.suppressed.map((s) => s.verdict.status)).toEqual(["declined", "cooling"]);
    expect(report.allowed).toEqual([]);
  });
});

describe("renderSuppressionNote", () => {
  it("says nothing when nothing was suppressed", () => {
    expect(renderSuppressionNote({ allowed: ["a"], suppressed: [], degraded: [] })).toEqual([]);
  });

  it("names the count, the split, and each key's reason", () => {
    const note = renderSuppressionNote({
      allowed: [],
      suppressed: [
        {
          key: "org-spec-audit/a",
          verdict: {
            status: "declined",
            reason: "settled in ADR-0011",
            by: "@ada",
            at: "2026-07-01",
          },
        },
        {
          key: "org-spec-audit/b",
          verdict: {
            status: "cooling",
            untilMs: NOW + 25 * DAY,
            until: "2026-09-02",
            pr: 12,
            url: "https://github.com/owner/control/pull/12",
            closedAtMs: NOW - 5 * DAY,
          },
        },
      ],
      degraded: [],
    }).join("\n");
    expect(note).toContain("**Suppressed: 2**");
    expect(note).toContain("1 previously declined, 1 in cooldown");
    expect(note).toContain("declined 2026-07-01 by @ada: settled in ADR-0011");
    expect(note).toContain("cooling until 2026-09-02");
  });

  it("prints the degradation so a short list is never mistaken for calm", () => {
    const note = renderSuppressionNote({
      allowed: ["a"],
      suppressed: [],
      degraded: ["ledger owner/control:x unreadable (GitHub 500 transient)"],
    }).join("\n");
    expect(note).toContain("Suppression degraded");
    expect(note).toContain("GitHub 500 transient");
  });
});
