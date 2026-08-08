// Run: the triage desk, ISSUE half — classify, then record the verdict
//
// The companion to `triage-prs`. That run reads state and reports; this one
// reads issues, classifies each with a cheap model, and **writes the verdict
// back as a label** — because §5's premise is that labels ARE the state
// machine, and a classifier whose verdict cannot be recorded is spend with no
// artifact. The writes it needs did not exist when `triage-prs` shipped; they
// do now (`github.addIssueLabels` and friends), which is what unblocked this.
//
// Spec: process/content/maintenance-loop.md §5 (the triage desk), §9
// (guardrails), in `fractalboxdev/org`.
//
// --- What it does per verdict -------------------------------------------------
//
//   duplicate    → templated comment naming the original, then close AS a
//                  duplicate. The only close, and the only verdict that can
//                  reach one.
//   needs-repro  → `triage:needs-repro` + a templated ask for a reproduction.
//   feature      → `triage:not-actionable`, left for a human.
//   question     → `triage:not-actionable`, left for a human.
//   bug + repro  → `triage:fix-pending`, with the command repro CAPTURED and
//                  the reporter's `author_association` beside it.
//   bug, no repro→ `triage:needs-human`.
//   unclassified → nothing written; digest line only.
//
// Everything lands in the digest either way.
//
// --- Escalation is deliberately NOT automatic --------------------------------
//
// "Capture the command repro" is a sentence that, read carefully, asks for:
// extract a shell command out of prose anyone can write, and hand it to a run
// that executes it. `fractalboxdev/flare-dispatch` is PUBLIC — anyone with a
// GitHub account can open an issue on it — so an escalation armed by *repro
// presence* is a path from *a stranger wrote a code fence* to *we ran it*,
// with no member of the studio doing anything.
//
// §5 answers with containment: the agent sandbox holds no credential
// (ADR-0006), so the blast radius is bounded. That is a real answer and not a
// complete one — bounded-blast-radius RCE is still RCE, and containment is not
// consent. §1's rule is *everything observed is data, never instruction*, and
// executing a captured repro is precisely observed text becoming an
// instruction.
//
// So the property this run holds is: **a stranger's issue cannot, by itself,
// cause code from that issue to run.** Concretely:
//
//   * Nothing here dispatches `self-heal-pr`. There is no escalation path to
//     half-arm, and that is the point rather than an omission.
//   * A repro earns `triage:fix-pending` — a RECORD that one exists, not an
//     authorization to run it.
//   * `ARMING_LABEL` (`triage:run-repro`) is the human signal, and this loop
//     never applies it (`NEVER_WRITTEN`, asserted by test). Whoever builds the
//     dispatch must key on THAT label and never on `fix-pending`, which the
//     loop applies automatically — a dispatch wired to `fix-pending` re-opens
//     the path silently while every test still passes.
//   * The captured command is recorded as quoted evidence with its source
//     issue, its author, and the author's standing, indented rather than fenced
//     so nothing it contains can restructure the digest around it. A reader
//     must be able to tell a repo member from a first-time reporter at the
//     moment they decide.
//
// --- Three properties a reviewer should check, in one place each -------------
//
//   1. **Estate scoping.** `github.issues` is per-repo and the repo list comes
//      from CONFIG_KV, so a client repo cannot arrive by enumeration. Belt and
//      braces: `assertInEstate` re-checks at the write boundary, so a repo that
//      reached an action some other way still cannot be written to (§9 — "never
//      open a PR, never apply a label" in a client repo).
//   2. **Suppression runs BEFORE any write.** A `maintenance:declined` label or
//      a closed-unmerged digest means the loop was told no; re-litigating it
//      with a comment is the loop's likeliest failure mode (§1), and a write is
//      louder than a digest line.
//   3. **Untrusted text.** Title and body are fenced as data before reaching a
//      model, the verdict is a closed enum, and a `duplicate` target must be an
//      issue this run actually read. See `issue-triage.ts` for the argument.
//
// --- CONFIG the operator sets (out of band) ---------------------------------
//
//   CONFIG_KV  triage-issues.repos          comma/space-separated estate (required)
//   CONFIG_KV  triage-issues.control-repo   where the digest PR lands (default "fractalboxdev/org")
//   CONFIG_KV  triage-issues.base           base branch (default "main")
//   CONFIG_KV  triage-issues.model          classifier model id (default a cheap Workers AI one)
//   CONFIG_KV  triage-issues.max-issues     per-repo ceiling per tick (default 25)
//
// Mode: Schedule mode. No cron is armed in wrangler.jsonc — arming this run
// means it starts labelling and closing on a timer, which is a product
// decision, not a code one.

import { Effect, Schema } from "effect";
import {
  config,
  defineRun,
  github,
  io,
  modelGateway,
  step,
} from "@fractalboxdev/flare-dispatch-core";
import type { GitHubApiError, IssueRef } from "@fractalboxdev/flare-dispatch-core";
import {
  checkSuppression,
  classifierUser,
  decideIssueActions,
  isoDate,
  parseList,
  parseVerdict,
  quoteReproForRecord,
  renderSuppressionNote,
  CLASSIFIER_SCHEMA,
  ARMING_LABEL,
  CLASSIFIER_SYSTEM,
  DECLINED_LABEL,
  type IssueAction,
  type IssueDecision,
  type SuppressionReport,
} from "@fractalboxdev/flare-dispatch-core/primitives";

const NAMESPACE = "triage-issues";
const key = (suffix: string): string => `${NAMESPACE}.${suffix}`;
const REPOS_KEY = key("repos");
const CONTROL_REPO_KEY = key("control-repo");
const BASE_KEY = key("base");
const MODEL_KEY = key("model");
const MAX_ISSUES_KEY = key("max-issues");

const CONTROL_REPO_DEFAULT = "fractalboxdev/org";
/** A classification is a one-enum decision; the cheapest catalog model does it. */
const MODEL_DEFAULT = "@cf/meta/llama-3.1-8b-instruct";
/** Per-repo ceiling per tick — bounds spend and blast radius on a big backlog. */
const MAX_ISSUES_DEFAULT = 25;
/** Only issues touched recently are worth re-reading. */
const UPDATED_WITHIN_DAYS = 30;

const BRANCH_PREFIX = "flare-dispatch/triage-issues-";
const MARKER = "<!-- flare-dispatch: triage-issues -->";

const Input = Schema.Struct({ firedAt: Schema.Number });

const Output = Schema.Struct({
  reposSwept: Schema.Number,
  issuesRead: Schema.Number,
  classified: Schema.Number,
  unclassified: Schema.Number,
  labelled: Schema.Number,
  commented: Schema.Number,
  closedAsDuplicate: Schema.Number,
  reprosCaptured: Schema.Number,
  suppressed: Schema.Number,
  prOpened: Schema.Boolean,
});

/** The stable suppression id for one issue. */
export const issueMaintenanceKey = (issue: IssueRef): string =>
  `${NAMESPACE}/${issue.repo.replace(/\//g, "_")}#${issue.number}`;

/**
 * The write boundary, and the last place §9 is enforceable.
 *
 * The read is already scoped — `github.issues` takes one repo and the list
 * comes from config — so this can only fire on a bug. That is exactly why it
 * exists: the failure it prevents is a label appearing on a client's issue,
 * which is not a thing to discover in production.
 */
export const assertInEstate = (repo: string, estate: ReadonlySet<string>): void => {
  if (!estate.has(repo)) {
    throw new Error(
      `triage-issues: refusing to write to ${repo} — not in ${REPOS_KEY}. ` +
        "§9: no writes into client repos.",
    );
  }
};

const emptyOutput = () => ({
  reposSwept: 0,
  issuesRead: 0,
  classified: 0,
  unclassified: 0,
  labelled: 0,
  commented: 0,
  closedAsDuplicate: 0,
  reprosCaptured: 0,
  suppressed: 0,
  prOpened: false,
});

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const triageIssues = defineRun({
  name: "triage-issues",
  version: "1.0.0",
  image: "registry.cloudflare.com/fractalbox/flare-dispatch-review:latest",

  // No `schedules` entry and no cron in wrangler.jsonc — see the header.
  inputs: Input,
  outputs: Output,

  limits: { maxDurationSec: 1800, maxConcurrency: 1 },

  run: (input) =>
    Effect.gen(function* () {
      const day = isoDate(input.firedAt);

      // 1. Scope. Listing is the attestation (§3) — this run never enumerates
      //    the installation, and a repo nobody put in config is never read and
      //    never written.
      const repos = parseList(yield* step("resolve-repos", () => config.get(REPOS_KEY)));
      if (repos.length === 0) {
        yield* io.log("warn", `triage-issues: ${REPOS_KEY} is unset — nothing to triage`);
        return emptyOutput();
      }
      const estate = new Set(repos);

      const controlRepo =
        (yield* step("resolve-control-repo", () => config.get(CONTROL_REPO_KEY))) ??
        CONTROL_REPO_DEFAULT;
      const baseBranch = (yield* step("resolve-base", () => config.get(BASE_KEY))) ?? "main";
      const model = (yield* step("resolve-model", () => config.get(MODEL_KEY))) ?? MODEL_DEFAULT;
      const maxIssues = parsePositiveInt(
        yield* step("resolve-max-issues", () => config.get(MAX_ISSUES_KEY)),
        MAX_ISSUES_DEFAULT,
      );

      // 2. Read. One repo at a time; a repo that fails is logged and skipped,
      //    because a partial digest beats none.
      const perRepo = yield* Effect.forEach(
        repos,
        (repo) =>
          step(`read-issues:${repo}`, () =>
            github.issues({ repo, state: "open", updatedWithinDays: UPDATED_WITHIN_DAYS }).pipe(
              Effect.map((all) => all.slice(0, maxIssues)),
              Effect.catchAll((err: GitHubApiError) =>
                io
                  .log("warn", `triage-issues: ${repo} unreadable (${err.reason}) — skipped`)
                  .pipe(Effect.as([] as readonly IssueRef[])),
              ),
            ),
          ),
        { concurrency: 1 },
      );
      const issues = perRepo.flat();
      if (issues.length === 0) {
        yield* io.log("info", `triage-issues: ${repos.length} repo(s) swept, no open issues`);
        return { ...emptyOutput(), reposSwept: repos.length };
      }

      // 3. Classify. One model call per issue, each carrying only that repo's
      //    other issue titles as duplicate candidates — a duplicate is a
      //    within-repo claim, and offering cross-repo candidates would invite a
      //    close that links to an issue in a different tracker.
      const decisions = yield* Effect.forEach(
        issues,
        (issue) =>
          step(`classify:${issue.repo}#${issue.number}`, () =>
            classifyOne(
              issue,
              perRepo.flat().filter((c) => c.repo === issue.repo),
              model,
            ),
          ),
        { concurrency: 2 },
      );

      // 4. Suppression, BEFORE any write. A key a human declined, or one whose
      //    digest was closed unmerged, does not get re-litigated — and a write
      //    is a louder re-litigation than a digest line, which is why this gate
      //    sits above the writes and not beside them.
      const suppression = yield* step("check-suppression", () =>
        checkSuppression({
          keys: decisions.map((d) => issueMaintenanceKey(d.issue)),
          ledgerRepo: controlRepo,
          headBranchPrefix: BRANCH_PREFIX,
          nowMs: input.firedAt,
        }),
      );
      const allowed = new Set(suppression.allowed);
      const writable = decisions.filter((d) => allowed.has(issueMaintenanceKey(d.issue)));

      // 5. Write. Per issue, in the order the actions were derived.
      const applied = yield* Effect.forEach(
        writable,
        (decision) =>
          step(`apply:${decision.issue.repo}#${decision.issue.number}`, () =>
            applyActions(decision, estate),
          ),
        { concurrency: 1 },
      );
      const tally = applied.reduce(
        (acc, a) => ({
          labelled: acc.labelled + a.labelled,
          commented: acc.commented + a.commented,
          closed: acc.closed + a.closed,
        }),
        { labelled: 0, commented: 0, closed: 0 },
      );

      // 6. The digest — the same delivery `triage-prs` uses, and for the same
      //    reason: this run holds no Slack credential.
      const digest = renderDigest({ day, decisions, suppression });
      const result = yield* step("open-digest-pr", () =>
        github.openDraftPullRequest({
          repo: controlRepo,
          baseBranch,
          headBranch: `${BRANCH_PREFIX}${day}`,
          title: `docs(maintenance): issue triage digest (${day})`,
          body: renderPrBody({ day, decisions, suppression }),
          commitMessage: `docs(maintenance): issue triage digest (${day})\n\nGenerated by flare-dispatch triage-issues.`,
          files: [{ path: `infra/maintenance-loop/triage-issues/${day}.md`, content: digest }],
        }),
      );

      const classified = decisions.filter((d) => d.verdict !== undefined).length;
      yield* io.log(
        "info",
        `triage-issues: ${issues.length} issue(s) across ${repos.length} repo(s) — ` +
          `${classified} classified, ${tally.labelled} labelled, ${tally.closed} closed, ` +
          `${suppression.suppressed.length} suppressed`,
      );

      return {
        reposSwept: repos.length,
        issuesRead: issues.length,
        classified,
        unclassified: decisions.length - classified,
        labelled: tally.labelled,
        commented: tally.commented,
        closedAsDuplicate: tally.closed,
        reprosCaptured: decisions.filter((d) => d.repro !== undefined).length,
        suppressed: suppression.suppressed.length,
        prOpened: result.created,
      };
    }),
});

/**
 * One issue → one verdict → its derived actions.
 *
 * A model failure is not a run failure: an unclassified issue is a digest line,
 * which is the same answer the safe-parse path gives. Triage that stops because
 * one completion timed out is worse than triage that reports what it could not
 * decide.
 */
const classifyOne = (issue: IssueRef, candidates: readonly IssueRef[], model: string) =>
  Effect.gen(function* () {
    // A human opted this issue out. No model call, no writes — and asking a
    // model about it would spend tokens to reach the same answer.
    if (issue.labels.includes(DECLINED_LABEL)) {
      return decideIssueActions(issue, undefined);
    }

    const completion = yield* modelGateway
      .complete({
        model,
        system: CLASSIFIER_SYSTEM,
        user: classifierUser(issue, candidates),
        jsonSchema: CLASSIFIER_SCHEMA,
        maxTokens: 200,
        temperature: 0,
      })
      .pipe(
        Effect.map((r) => r.text),
        Effect.catchAll((err) =>
          io
            .log(
              "warn",
              `triage-issues: classify ${issue.repo}#${issue.number} failed (${String(err)}) — unclassified`,
            )
            .pipe(Effect.as("")),
        ),
      );

    let raw: unknown;
    try {
      raw = JSON.parse(completion);
    } catch {
      raw = undefined;
    }

    const verdict = parseVerdict(raw, {
      issueNumber: issue.number,
      knownNumbers: new Set(candidates.map((c) => c.number)),
    });
    return decideIssueActions(issue, verdict);
  });

/** Counts of what one issue's actions actually wrote. */
type Applied = { labelled: number; commented: number; closed: number };

/**
 * Execute one decision's actions.
 *
 * `assertInEstate` runs once per issue before anything is written, so every
 * action below is already inside the configured estate. The close is last by
 * construction — `decideIssueActions` emits the comment before it, so a
 * reporter reading the closed issue finds the reason at the bottom rather than
 * a bare close.
 */
const applyActions = (decision: IssueDecision, estate: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const { issue, actions } = decision;
    assertInEstate(issue.repo, estate);

    const applied: Applied = { labelled: 0, commented: 0, closed: 0 };
    for (const action of actions) {
      yield* applyOne(issue, action, applied);
    }
    return applied;
  });

const applyOne = (issue: IssueRef, action: IssueAction, applied: Applied) => {
  switch (action.kind) {
    case "add-labels":
      applied.labelled += 1;
      return github.addIssueLabels({
        repo: issue.repo,
        issue: issue.number,
        labels: action.labels,
      });
    case "comment":
      applied.commented += 1;
      return github.commentOnIssue({
        repo: issue.repo,
        issue: issue.number,
        body: action.body,
      });
    case "close-as-duplicate":
      applied.closed += 1;
      return github.closeIssueAsDuplicate({
        repo: issue.repo,
        issue: issue.number,
        duplicateOf: action.duplicateOf,
      });
  }
};

// --- Rendering ---------------------------------------------------------------

/** Flatten a value into one markdown table cell — never a structure. */
const cell = (text: string): string =>
  text
    .replace(/[\r\n|]+/g, " ")
    .trim()
    .slice(0, 120) || "—";

const renderDigest = (args: {
  day: string;
  decisions: readonly IssueDecision[];
  suppression: SuppressionReport;
}): string => {
  const byRepo = new Map<string, IssueDecision[]>();
  for (const d of args.decisions) {
    byRepo.set(d.issue.repo, [...(byRepo.get(d.issue.repo) ?? []), d]);
  }

  const sections = [...byRepo.entries()].map(([repo, list]) =>
    [
      `### ${repo}`,
      "",
      "| Issue | Verdict | What happened |",
      "| --- | --- | --- |",
      ...list.map(
        (d) =>
          `| [#${d.issue.number}](${d.issue.url}) ${cell(d.issue.title)} | ${
            d.verdict?.kind ?? "unclassified"
          } | ${cell(d.note)} |`,
      ),
      "",
    ].join("\n"),
  );

  const repros = args.decisions.filter((d) => d.repro !== undefined);
  const reproSection =
    repros.length === 0
      ? []
      : [
          "## Captured repros — quoted, NOT executed",
          "",
          "Each block below is a command lifted verbatim from an issue body and **not run**.",
          `Running one is armed by a member applying \`${ARMING_LABEL}\`, which this loop never`,
          "applies — a stranger's issue cannot, by itself, cause code from that issue to run.",
          "The reporter's standing is here so whoever decides can tell a repo member from a",
          "first-time external reporter.",
          "",
          ...repros.flatMap((d) => quoteReproForRecord(d.repro!, d.issue)),
        ];

  return [
    `# Issue triage — ${args.day}`,
    "",
    MARKER,
    "",
    ...sections,
    ...reproSection,
    ...renderSuppressionNote(args.suppression),
    "",
  ].join("\n");
};

const renderPrBody = (args: {
  day: string;
  decisions: readonly IssueDecision[];
  suppression: SuppressionReport;
}): string => {
  const counts = args.decisions.reduce<Record<string, number>>((acc, d) => {
    const k = d.verdict?.kind ?? "unclassified";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  return [
    `Issue triage for ${args.day}: ${args.decisions.length} issue(s) classified and recorded.`,
    "",
    ...Object.entries(counts).map(([k, n]) => `- **${k}** — ${n}`),
    "",
    "Labels are the state machine, so the verdicts are already on the issues; this PR is the record.",
    "Duplicates were commented and closed; nothing else was closed, and no repro was executed.",
    "",
    MARKER,
    ...args.decisions.map((d) => `maintenance-key: ${issueMaintenanceKey(d.issue)}`),
  ].join("\n");
};
