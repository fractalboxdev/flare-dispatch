// Run: the triage desk, PR half — state, then route
//
// A Schedule-mode run that reads every open PR across the configured estate,
// derives its state (CI health, review state, staleness, labels), and routes it
// to exactly one of §5's four exits: auto-merge · nudge · unstick · ask. It
// then opens ONE digest PR against the control repo carrying the grouped
// result, the same delivery `org-spec-audit` uses and for the same reason —
// this run holds no Slack credential.
//
// Spec: process/content/maintenance-loop.md §5 (the triage desk), §9
// (guardrails), in `fractalboxdev/org`.
//
// --- It decides and reports; it does not act ---------------------------------
//
// Three of the four exits name an action this codebase cannot perform, and
// saying so is more useful than pretending otherwise:
//
//   * auto-merge — there is no merge on `GithubService`, deliberately. The gate
//     below refuses everything today anyway (`enabled: false`), and a merge
//     capability that exists before the promotion ladder does is a capability
//     waiting to be mis-wired.
//   * nudge — assigning a reviewer needs an issue-assignment write. The digest
//     names the reviewer of record instead, which is the same information one
//     click further away.
//   * unstick — dispatching a rebase / re-run needs a workflow-dispatch write.
//     The digest names the check that is red.
//
// So every exit lands in the digest, and the auto-merge lane additionally
// reports *why* the gate refused. That is a full implementation of the routing
// decision and an honest account of the action surface, rather than three
// no-op branches that read as working.
//
// --- Why the PR half and not the issue half ----------------------------------
//
// §5's issue machine — classify, label, comment, link-and-close duplicates —
// needs five writes that do not exist (`labels`, issue read, issue comment,
// issue close, assignment) and one read (issues). "Labels are the state
// machine" is not implementable against a capability surface with no label
// write, and a classifier whose output cannot be recorded is a model call that
// produces nothing. The PR half needs none of that: its state is already
// readable, which is why it is here and the issue half is a separate PR.
//
// --- CONFIG the operator sets (out of band) ---------------------------------
//
//   CONFIG_KV  triage-prs.repos          comma/space-separated estate (required)
//   CONFIG_KV  triage-prs.control-repo   where the digest PR lands (default "fractalboxdev/org")
//   CONFIG_KV  triage-prs.base           base branch (default "main")
//   CONFIG_KV  triage-prs.stale-hours    unreviewed age that earns a nudge (default 24)
//   CONFIG_KV  triage-prs.flaky-checks   check names a red run treats as unstick-able
//   CONFIG_KV  triage-prs.reviewers      `repo=@handle` pairs — the reviewer of record
//
// Mode: Schedule mode. No cron is armed in wrangler.jsonc — arming this is a
// product decision, not a code one.

import { Effect, Schema } from "effect";
import { config, defineRun, github, io, step } from "@fractalboxdev/flare-dispatch-core";
import type {
  GitHubApiError,
  PullRequestHistoryRef,
  StepFailed,
  WorkflowRunRef,
} from "@fractalboxdev/flare-dispatch-core";
import {
  checkSuppression,
  describeMergeVerdict,
  evaluateAutomerge,
  isoDate,
  loadAutomergeConfig,
  type AutomergeConfig,
  type MergeVerdict,
  parseList,
  renderSuppressionNote,
  type SuppressionReport,
} from "@fractalboxdev/flare-dispatch-core/primitives";

const NAMESPACE = "triage-prs";
const key = (suffix: string): string => `${NAMESPACE}.${suffix}`;
const REPOS_KEY = key("repos");
const CONTROL_REPO_KEY = key("control-repo");
const BASE_KEY = key("base");
const STALE_HOURS_KEY = key("stale-hours");
const FLAKY_CHECKS_KEY = key("flaky-checks");
const REVIEWERS_KEY = key("reviewers");

const CONTROL_REPO_DEFAULT = "fractalboxdev/org";
/** Green CI + nobody assigned + older than this ⇒ nudge. */
const STALE_HOURS_DEFAULT = 24;
/** Cap per exit in the digest, so one noisy repo cannot bury the rest. */
const PER_EXIT_CAP = 8;

const MAINTENANCE_SOURCE = "triage-prs";
const BRANCH_PREFIX = "flare-dispatch/triage-digest-";
const MARKER = "<!-- flare-dispatch: triage-prs -->";

/** The four exits, in digest order — most actionable first. */
const EXITS = ["ask", "nudge", "unstick", "automerge"] as const;
type Exit = (typeof EXITS)[number];

const EXIT_HEADING: Record<Exit, string> = {
  ask: "Ask — needs a decision nobody has made",
  nudge: "Nudge — green and unowned",
  unstick: "Unstick — blocked on something mechanical",
  automerge: "Auto-merge lane — eligibility checked, nothing merged",
};

/**
 * How the loop identifies a PR it produced itself. Every loop run stamps its
 * name in an HTML comment; `neverEligibleRuns` is matched against this.
 */
const RUN_MARKER = /<!--\s*flare-dispatch:\s*([a-z0-9-]+)\s*-->/;

const Input = Schema.Struct({ firedAt: Schema.Number });

const Output = Schema.Struct({
  reposSwept: Schema.Number,
  prsRouted: Schema.Number,
  ask: Schema.Number,
  nudge: Schema.Number,
  unstick: Schema.Number,
  /** PRs that reached the gate. Merged is deliberately absent — see the header. */
  automergeConsidered: Schema.Number,
  automergePermitted: Schema.Number,
  digestSuppressed: Schema.Number,
  prOpened: Schema.Boolean,
});

export const triagePrs = defineRun({
  name: "triage-prs",
  version: "1.0.0",
  image: "registry.cloudflare.com/fractalbox/flare-dispatch-review:latest",

  // No `schedules` entry and no cron in wrangler.jsonc: arming the desk is a
  // product decision. The run is dispatchable by hand until someone makes it.
  inputs: Input,
  outputs: Output,

  limits: { maxDurationSec: 1800, maxConcurrency: 2 },

  run: (input) =>
    Effect.gen(function* () {
      const day = isoDate(input.firedAt);

      // 1. Scope. Listing is the attestation — §3. This run never enumerates
      //    the installation, and it never touches a repo nobody put in config.
      const repos = parseList(yield* step("resolve-repos", () => config.get(REPOS_KEY)));
      if (repos.length === 0) {
        yield* io.log("warn", `triage-prs: ${REPOS_KEY} is unset — nothing to triage`);
        return emptyOutput();
      }

      const controlRepo =
        (yield* step("resolve-control-repo", () => config.get(CONTROL_REPO_KEY))) ??
        CONTROL_REPO_DEFAULT;
      const baseBranch = (yield* step("resolve-base", () => config.get(BASE_KEY))) ?? "main";
      const staleHours = parseStaleHours(
        yield* step("resolve-stale-hours", () => config.get(STALE_HOURS_KEY)),
      );
      const flakyChecks = parseList(
        yield* step("resolve-flaky-checks", () => config.get(FLAKY_CHECKS_KEY)),
      );
      const reviewers = parseReviewers(
        yield* step("resolve-reviewers", () => config.get(REVIEWERS_KEY)),
      );

      // 2. The allowlist, read from the control repo. Unreadable ⇒ the closed
      //    config ⇒ every candidate refuses. Loudly, and never silently open.
      const automerge = yield* step("load-automerge-config", () =>
        loadAutomergeConfig({ repo: controlRepo }),
      );

      // 3. Read each repo's open PRs and its recent CI. One repo's failure is
      //    logged and skipped — a partial digest still beats none.
      const swept = yield* Effect.forEach(
        repos,
        (repo) =>
          sweepRepo({ repo, staleHours, flakyChecks, automerge, nowMs: input.firedAt }).pipe(
            Effect.catchAll((err) =>
              io
                .log("warn", `triage-prs: skipped ${repo} — ${describeError(err)}`)
                .pipe(Effect.as([] as readonly RoutedPr[])),
            ),
          ),
        { concurrency: 2 },
      );
      const routed = swept.flat();

      // 4. Empty means silent — a digest that fires with no news is one people
      //    learn to skip (§5, inherited from the activity digest).
      if (routed.length === 0) {
        yield* io.log("info", `triage-prs: ${repos.length} repo(s) swept, no open PRs to route`);
        return { ...emptyOutput(), reposSwept: repos.length };
      }

      // 5. Suppression. A digest line a human already declined is not re-raised;
      //    one whose digest PR was closed unmerged waits out its cooldown.
      const suppression = yield* step("check-suppression", () =>
        checkSuppression({
          keys: routed.map((pr) => maintenanceKey(pr)),
          ledgerRepo: controlRepo,
          headBranchPrefix: BRANCH_PREFIX,
          nowMs: input.firedAt,
        }),
      );
      const allowed = new Set(suppression.allowed);
      const proposed = routed.filter((pr) => allowed.has(maintenanceKey(pr)));

      if (proposed.length === 0) {
        yield* io.log(
          "info",
          `triage-prs: ${routed.length} routed, all suppressed — no digest opened`,
        );
        return {
          ...tally(routed),
          reposSwept: repos.length,
          digestSuppressed: suppression.suppressed.length,
          prOpened: false,
        };
      }

      // 6. One digest PR against the control repo.
      const digest = renderDigest({ day, routed: proposed, reviewers, suppression });
      const result = yield* step("open-digest-pr", () =>
        github.openDraftPullRequest({
          repo: controlRepo,
          baseBranch,
          headBranch: `${BRANCH_PREFIX}${day}`,
          title: `docs(maintenance): PR triage digest (${day})`,
          body: renderPrBody({ day, routed: proposed, reviewers, suppression, digest }),
          commitMessage: `docs(maintenance): PR triage digest (${day})\n\nGenerated by flare-dispatch triage-prs.`,
          files: [{ path: `infra/maintenance-loop/triage/${day}.md`, content: digest }],
        }),
      );

      yield* io.log(
        "info",
        `triage-prs: ${proposed.length} PR(s) routed across ${repos.length} repo(s) (${suppression.suppressed.length} suppressed) — ${result.created ? "opened" : "updated"} PR #${result.number}`,
      );

      return {
        ...tally(proposed),
        reposSwept: repos.length,
        digestSuppressed: suppression.suppressed.length,
        prOpened: result.created,
      };
    }),
});

// ---------------------------------------------------------------------------

/** One open PR, with the exit it routed to and why. */
export type RoutedPr = {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: string;
  readonly exit: Exit;
  /** The one sentence that says what would unblock it. */
  readonly reason: string;
  /** Present only in the auto-merge lane — what the gate decided. */
  readonly verdict?: MergeVerdict;
};

type SweepArgs = {
  readonly repo: string;
  readonly staleHours: number;
  readonly flakyChecks: readonly string[];
  readonly automerge: AutomergeConfig;
  readonly nowMs: number;
};

/**
 * Read one repo's open PRs and route each.
 *
 * Uses `pullRequestHistory` with `state: "open"` rather than
 * `openPullRequests`: the latter enumerates every installed repo and is an
 * `Effect.die` stub in the live Layer (`github-live.ts`), so a run built on it
 * would die in production. This one is pointed at a named repo, which is also
 * what §3's "listing is the attestation" wants.
 */
const sweepRepo = (args: SweepArgs) =>
  Effect.gen(function* () {
    const prs = yield* step(`list-prs-${args.repo}`, () =>
      github.pullRequestHistory({ repo: args.repo, state: "open" }),
    );
    const open = prs.filter((pr) => !pr.draft);
    if (open.length === 0) return [] as readonly RoutedPr[];

    // One CI read per repo, not per PR — the runs come back keyed by head sha.
    const runs = yield* step(`ci-${args.repo}`, () =>
      github.actionRuns({ repos: [args.repo], createdWithinHours: 24 * 14 }),
    );

    return open.map((pr) => routePr(pr, runs, args));
  });

/**
 * Route one PR to exactly one exit — pure, so every branch is testable without
 * a network.
 *
 * Order is precedence, not preference: the auto-merge lane is considered first
 * so that a PR eligible for it is never quietly re-routed to `ask` by a later
 * condition, and its refusal is always recorded. `unstick` outranks `nudge`
 * because a red PR is not waiting on a reviewer, it is waiting on a green run.
 */
export const routePr = (
  pr: PullRequestHistoryRef,
  runs: readonly WorkflowRunRef[],
  args: {
    readonly staleHours: number;
    readonly flakyChecks: readonly string[];
    readonly automerge: AutomergeConfig;
    readonly nowMs: number;
  },
): RoutedPr => {
  const ci = ciHealth(pr, runs);
  const producedByRun = RUN_MARKER.exec(pr.body)?.[1];
  const base = {
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
  } as const;

  // The auto-merge lane: anything the loop itself produced is *considered*,
  // which means its refusal gets written down. A PR that never reaches the gate
  // is a PR whose eligibility nobody can audit.
  if (producedByRun !== undefined) {
    const verdict = evaluateAutomerge(args.automerge, {
      repo: pr.repo,
      number: pr.number,
      author: pr.author,
      producedByRun,
      // The change class and the diff's paths are not on the list endpoint.
      // Both absent read as "undeclared" and "unknown", and the gate refuses on
      // an undeclared class before it ever asks about paths — so an unknown
      // diff can never be mistaken for a clean one.
      changedPaths: [],
      checksGreen: ci.green,
      reviewPosted: pr.labels.includes("pr-review:posted"),
      mergesToday: 0,
    });
    return {
      ...base,
      exit: "automerge",
      reason: describeMergeVerdict(verdict),
      verdict,
    };
  }

  if (ci.red) {
    const flaky = args.flakyChecks.includes(ci.failingCheck ?? "");
    return {
      ...base,
      exit: "unstick",
      reason: flaky
        ? `\`${ci.failingCheck}\` is red and is a known-flaky check — re-run it`
        : `\`${ci.failingCheck ?? "CI"}\` is red — needs a fix or a re-run`,
    };
  }

  const ageHours = (args.nowMs - pr.updatedAt) / 3_600_000;
  if (ci.green && pr.requestedReviewers.length === 0 && ageHours > args.staleHours) {
    return {
      ...base,
      exit: "nudge",
      reason: `green for ${Math.floor(ageHours)}h with no reviewer requested`,
    };
  }

  return {
    ...base,
    exit: "ask",
    reason: ci.green
      ? "green and reviewed-pending — does this still want to land?"
      : "no CI result yet — is it waiting on something?",
  };
};

/** One-liner for whichever failure a repo sweep raised (GitHub read or step). */
const describeError = (err: StepFailed | GitHubApiError): string =>
  err._tag === "GitHubApiError" ? `GitHub API ${err.status} (${err.reason})` : `${err.step} failed`;

/** CI verdict for a PR's head sha, from the repo's recent workflow runs. */
const ciHealth = (
  pr: PullRequestHistoryRef,
  runs: readonly WorkflowRunRef[],
): { green: boolean; red: boolean; failingCheck?: string } => {
  const mine = runs.filter((r) => r.headSha === pr.headSha || r.headBranch === pr.headBranch);
  if (mine.length === 0) return { green: false, red: false };
  const failing = mine.find((r) => r.conclusion === "failure" || r.conclusion === "timed_out");
  if (failing !== undefined) return { green: false, red: true, failingCheck: failing.name };
  return { green: mine.every((r) => r.conclusion === "success"), red: false };
};

/** The suppression key for a routed PR — stable across ticks, per PR. */
const maintenanceKey = (pr: RoutedPr): string =>
  `${MAINTENANCE_SOURCE}/${pr.repo}#${pr.number}-${pr.exit}`;

/** `stale-hours` as a positive integer, falling back to the default. */
export const parseStaleHours = (raw: string | undefined | null): number => {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : STALE_HOURS_DEFAULT;
};

/** Parse `owner/repo=@handle` pairs into a reviewer-of-record lookup. */
export const parseReviewers = (raw: string | undefined | null): ReadonlyMap<string, string> => {
  const pairs = new Map<string, string>();
  for (const entry of parseList(raw ?? undefined)) {
    const eq = entry.indexOf("=");
    if (eq <= 0 || eq === entry.length - 1) continue;
    pairs.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return pairs;
};

const emptyOutput = () => ({
  reposSwept: 0,
  prsRouted: 0,
  ask: 0,
  nudge: 0,
  unstick: 0,
  automergeConsidered: 0,
  automergePermitted: 0,
  digestSuppressed: 0,
  prOpened: false,
});

/** Count each exit — the numbers the run reports and the digest header shows. */
const tally = (routed: readonly RoutedPr[]) => ({
  prsRouted: routed.length,
  ask: routed.filter((p) => p.exit === "ask").length,
  nudge: routed.filter((p) => p.exit === "nudge").length,
  unstick: routed.filter((p) => p.exit === "unstick").length,
  automergeConsidered: routed.filter((p) => p.exit === "automerge").length,
  automergePermitted: routed.filter((p) => p.verdict?.permitted === true).length,
});

type RenderArgs = {
  readonly day: string;
  readonly routed: readonly RoutedPr[];
  readonly reviewers: ReadonlyMap<string, string>;
  readonly suppression: SuppressionReport;
};

/**
 * The digest file — and the message FractalBOT posts, verbatim. Markdown, not
 * Slack mrkdwn: the reviewed file in git is the canonical artifact and the
 * Slack twin is derived at send time by whoever holds the token.
 */
export const renderDigest = (args: RenderArgs): string => {
  const counts = tally(args.routed);
  const lines: string[] = [
    `# PR triage — ${args.day}`,
    "",
    `${counts.prsRouted} open PR(s) routed · ${counts.ask} need a decision · ` +
      `${counts.nudge} unowned · ${counts.unstick} blocked · ` +
      `${counts.automergeConsidered} checked against the auto-merge gate` +
      (args.suppression.suppressed.length > 0
        ? ` · ${args.suppression.suppressed.length} suppressed`
        : ""),
    "",
    ...renderSuppressionNote(args.suppression),
  ];

  for (const exit of EXITS) {
    const inExit = args.routed.filter((p) => p.exit === exit);
    if (inExit.length === 0) continue;

    lines.push(`## ${EXIT_HEADING[exit]} (${inExit.length})`, "");
    if (exit === "automerge") {
      // Never let this section read as "merged". Nothing merged; nothing can.
      lines.push(
        "_Nothing here was merged — no run in this codebase can merge. These are gate verdicts, recorded so a refusal is auditable._",
        "",
      );
    }
    for (const pr of inExit.slice(0, PER_EXIT_CAP)) {
      const reviewer = args.reviewers.get(pr.repo);
      lines.push(
        `- [\`${pr.repo}#${pr.number}\`](${pr.url}) — ${pr.title}`,
        `  - ${pr.reason}`,
        ...(exit === "nudge" && reviewer !== undefined
          ? [`  - reviewer of record: ${reviewer}`]
          : exit === "nudge"
            ? ["  - no reviewer of record recorded for this repo — §3 calls that a gap"]
            : []),
      );
    }
    if (inExit.length > PER_EXIT_CAP) {
      lines.push(`- _${inExit.length - PER_EXIT_CAP} more in this group, not shown._`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
};

/** The PR body — the digest plus the loop's machine-readable lines. */
const renderPrBody = (args: RenderArgs & { digest: string }): string =>
  [
    "### PR triage digest",
    "",
    "> 🤖 Draft opened by `flare-dispatch/triage-prs`. Each line is a routing decision, not an action taken — this run merges nothing, assigns nobody, and dispatches no re-runs. Closing this unmerged suppresses every key below for 30 days.",
    "",
    args.digest,
    "",
    ...args.routed.map((pr) => `maintenance-key: ${maintenanceKey(pr)}`),
    `suppressed: ${args.suppression.suppressed.length}`,
    "auto-merge: never (this is the loop's own config surface)",
    "",
    MARKER,
  ].join("\n");
