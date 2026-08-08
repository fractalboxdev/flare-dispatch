// Run: scheduled estate-wide spec audit → the open questions, grouped
//
// A Schedule-mode run that sweeps every configured repo, reads each one's
// `specs/` against its tree, and collects the divergences that CANNOT be
// reconciled automatically — the ones where *which side is right* is a
// judgment nobody has made yet. It deduplicates them across the estate, groups
// them by the answer that unblocks them, and opens ONE draft PR against the
// control repo carrying the grouped list as a dated markdown file.
//
// --- Why this is a separate run from `spec-drift-pr` -------------------------
//
// `spec-drift-pr` (daily 05:00 UTC) already reconciles what CAN be reconciled:
// a spec contradicted by the tree is stale, and the code wins. It opens the
// fix PRs and this run does not duplicate them.
//
// What it structurally cannot do is the other half. A spec's most expensive
// drift is the part no run can reconcile because the decision was never taken
// — an ADR the code quietly violates, a `Planned` section unstarted for two
// quarters, two specs in different repos that disagree. Per repo those die in
// a PR body. Across an estate the same question is usually raised in three
// repos, and answering it once closes all three. That merge is the entire
// reason this sweeps instead of running per repo, and it is why the output is
// ONE PR against the control repo rather than one per repo.
//
// --- Delivery: the file is the record, the notice is the announcement --------
//
// This run does not post to Slack, and must not be given a way to. Slack bot
// tokens live with the Slack ingress and stay there (see
// `apps/dispatcher/src/slack-notify.ts`) — a cron run holding a workspace-write
// credential is how a token ends up somewhere nobody meant it to be.
//
// So it does two things with one rendering. The PR carries the message as a
// dated markdown file: that is the durable artifact and the reviewed record,
// and answering in its thread is how the questions get closed. Then
// `notice.publish` hands the SAME text to the `notice` capability, which names
// a use case and nothing else; the Slack ingress resolves that to a room and
// posts it with the token it already holds. One direction of trust, no new
// credential here, and no second wording to drift from the first.
//
// Both halves are best-effort in the one direction that matters: a notice that
// did not land is a logged line, never a verdict. The questions are already in
// git, which is the copy that has to survive.
//
// --- Suppression: the loop's memory ------------------------------------------
//
// Before it proposes anything, the run asks the `suppression` primitive which
// of today's questions it has already been told no to. A key in the control
// repo's declines ledger is never proposed again; a
// question whose proposal a human closed unmerged waits out a 30-day cooldown
// dated from `closed_at`. Every proposed question carries its own
// `maintenance-key: org-spec-audit/<question-key>` line in the PR body — that
// line is what both halves match on.
//
// The suppressed count and the reason for each appear in the PR body AND in the
// message file, because a silently shorter list reads as "fewer problems",
// which is the opposite of what it means. Both reads fail open: if the ledger
// or the PR history cannot be read, the run proposes anyway and prints the
// warning, since a duplicate PR is a nuisance and a silently disabled loop is
// the failure the mechanism exists to prevent.
//
// --- CONFIG the operator sets (out of band) ---------------------------------
//
// Every value that names an operator's own estate is a key, not a constant.
// This run is generic machinery — which repos it reads, which repo it writes
// to, and where in that repo the file lands are the operator's business and
// live in their config, never in this file. A default that names somebody's
// repo is a default that files a PR against it.
//
// Unset keys are not uniform, and the split is deliberate. An unset `repos` is
// a run nobody has pointed at anything yet: it warns and no-ops, because on a
// fresh install the cron fires before the estate is configured and a daily red
// tick trains operators to ignore the check. An unset `control-repo` is the
// opposite — the sweep would do all its work with nowhere to put the answer —
// so that one fails the run loudly.
//
//   CONFIG_KV  org-spec-audit.repos          comma/space-separated `owner/name` estate to sweep (optional — unset disables the sweep)
//   CONFIG_KV  org-spec-audit.base           base branch to read (default "main")
//   CONFIG_KV  org-spec-audit.control-repo   `owner/name` the questions PR lands in (REQUIRED — no default)
//   CONFIG_KV  org-spec-audit.questions-dir  repo-relative dir for `<date>.md` (default "maintenance/questions")
//   CONFIG_KV  org-spec-audit.declined-path  repo-relative declines ledger (default "maintenance/declined.jsonl")
//   CONFIG_KV  org-spec-audit.window-hours   skip a repo with no commits in this window (default "26")
//   CONFIG_KV  org-spec-audit.backend        "workers-ai" | "anthropic" | "bedrock" (default workers-ai)
//   CONFIG_KV  org-spec-audit.prompt         (optional) override the question-detection system prompt
//   CONFIG_KV  org-spec-audit.workers-ai.model  model id
//   CONFIG_KV  org-spec-audit.workers-ai.mode   "tools" | "json" (default "tools")
//
// Mode: Schedule mode — specs/04-gha-integration.md § Schedule mode. The cron
// MUST also be in wrangler.jsonc `triggers.crons`.

import { Effect, Match, Schema } from "effect";
import {
  config,
  defineRun,
  github,
  io,
  notice,
  sandbox,
  StepFailed,
  step,
  type Container,
} from "@fractalboxdev/flare-dispatch-core";
import type { CheckoutFailed, GitHubApiError } from "@fractalboxdev/flare-dispatch-core";
import {
  checkSuppression,
  DECLINED_LEDGER_PATH,
  isoDate,
  parseGitRef,
  parseList,
  parseRepo,
  parseRepoRelativePath,
  renderSuppressionNote,
  type SuppressionReport,
  workspace,
} from "@fractalboxdev/flare-dispatch-core/primitives";
import {
  type BackendUnconfigured,
  completeStructured,
  type ModelCallFailed,
  namespacedKey,
  promptKey,
  resolveBackend,
  type StructuredOutputInvalid,
} from "@fractalboxdev/flare-dispatch-review-agent";

/** The config namespace — every key this run reads is `org-spec-audit.*`. */
const NAMESPACE = "org-spec-audit";
const key = namespacedKey(NAMESPACE);
const REPOS_KEY = key("repos");
const BASE_KEY = key("base");
const CONTROL_REPO_KEY = key("control-repo");
const QUESTIONS_DIR_KEY = key("questions-dir");
const DECLINED_PATH_KEY = key("declined-path");
const WINDOW_HOURS_KEY = key("window-hours");

/**
 * Where the dated questions file lands inside the control repo.
 *
 * A directory, not a template: the run appends `<date>.md`, so there is no
 * placeholder syntax to get wrong and no way for config to name a single file
 * that every day overwrites.
 */
const QUESTIONS_DIR_DEFAULT = "maintenance/questions";

/**
 * The `maintenance-key` namespace and the branch prefix every proposal shares.
 *
 * Both are load-bearing for suppression: the key is what the ledger matches on,
 * and the prefix is how a later tick finds the PRs a human already closed
 * (each day's proposal gets its own dated branch, so the prefix is all they
 * have in common).
 */
const MAINTENANCE_SOURCE = "org-spec-audit";
const BRANCH_PREFIX = "flare-dispatch/spec-audit-questions-";

/** The stable, repo-independent id a question is suppressed by. */
const maintenanceKey = (questionKey: string): string => `${MAINTENANCE_SOURCE}/${questionKey}`;

/**
 * The routing key the notice carries. A KIND of message, not a destination —
 * the Slack ingress maps it to a room in its own deploy config, and a use case
 * it has no mapping for is refused there. Adding a destination is a PR against
 * that repo, never a value this run could set.
 */
const NOTICE_USE_CASE = "org-spec-audit";

/** A repo with no commits in this window is skipped before any model call. */
const WINDOW_HOURS_DEFAULT = 26;

/** Caps so a huge repo can't blow the model context window. */
const MAX_SPECS_CHARS = 40_000;
const MAX_TREE_CHARS = 12_000;
const QUESTIONS_MAX_TOKENS = 2048;

/** How many questions per group reach the message. The rest are counted, not dropped silently. */
const PER_GROUP_CAP = 5;

/**
 * The four groups, in message order.
 *
 * Grouped by the ANSWER that unblocks a question, not by the repo it came from
 * — whoever can settle ownership settles it for every repo in one reading,
 * which a per-repo grouping makes impossible.
 */
const GROUPS = ["decide", "confirm", "own", "retire"] as const;
type Group = (typeof GROUPS)[number];

/** Heading and one-line gloss per group, for the rendered message. */
const GROUP_HEADING: Record<Group, string> = {
  decide: "Decide — a design choice the specs never settled",
  confirm: "Confirm — a fact someone already knows",
  own: "Own — something real with no named owner",
  retire: "Retire — intent that may be dead",
};

/** One unresolvable divergence, as the model reports it. */
const AuditQuestions = Schema.Struct({
  questions: Schema.Array(
    Schema.Struct({
      /** Which kind of answer unblocks it. */
      group: Schema.Literal(...GROUPS),
      /** One sentence, answerable as asked. */
      question: Schema.String,
      /** The spec claim and what contradicts it — both sides, or it is not a finding. */
      evidence: Schema.String,
      /** Repo-relative path of the spec that raised it. */
      specPath: Schema.String,
      /** What we assume if nobody answers. */
      assumption: Schema.String,
      /**
       * A stable, repo-INDEPENDENT slug of the underlying question. Two repos
       * asking the same thing must produce the same key or the cross-repo
       * merge — the reason this run sweeps at all — silently does nothing.
       */
      key: Schema.String,
    }),
  ),
});

/** The question-detection prompt (operator-overridable). */
const QUESTIONS_PROMPT_DEFAULT = `You read a project's specs/ against its file tree and recent commits, and you
report ONLY what cannot be reconciled automatically.

Something IS a question when answering it needs a human decision or a fact no
file states: an architecture decision record the tree contradicts, a section
marked TODO/Planned/🚧 that is unstarted and unmentioned in recent commits, two
specs that disagree, a documented owner or status that nothing supports.

Something is NOT a question when the code plainly settles it. A spec
contradicted by the tree is ordinary drift, the code wins, and another run
already fixes it — do not report drift here.

Rules, each of which drops a finding when broken:
- One sentence, answerable as asked. "Does X still commit to Y?" not "clarify X".
- Cite both sides in evidence: the spec claim, and what contradicts it. No
  evidence, no question.
- State the assumption we should make if nobody answers. A question without one
  waits for a meeting.
- The key is a short lowercase slug of the UNDERLYING question, with no repo
  name in it, so the same question asked in two repos merges into one line.
- Report nothing rather than padding. An empty array is a good answer.`;

const Input = Schema.Struct({
  firedAt: Schema.Number,
});

const Output = Schema.Struct({
  reposSwept: Schema.Number,
  reposSkipped: Schema.Number,
  questionsRaised: Schema.Number,
  questionsAfterMerge: Schema.Number,
  /** Merged questions the ledger or a cooldown kept out of the proposal. */
  questionsSuppressed: Schema.Number,
  prOpened: Schema.Boolean,
});

export const orgSpecAudit = defineRun({
  name: "org-spec-audit",
  version: "1.0.0",
  image: "registry.cloudflare.com/fractalbox/flare-dispatch-review:latest",

  // Schedule mode: 05:45 UTC daily — after `spec-drift-pr` (05:00), so the
  // day's fix PRs already exist and the questions are what those PRs left. The
  // 05:30 slot is deliberately not taken; the maintenance loop reserves it for
  // `upstream-upgrade-pr`. Must also appear in wrangler.jsonc `triggers.crons`.
  schedules: [
    {
      cron: "45 5 * * *",
      idempotencyKey: ({ firedAt }) => `org-spec-audit:${isoDate(firedAt)}`,
      inputs: ({ firedAt }) => ({ firedAt }),
    },
  ],

  inputs: Input,
  outputs: Output,

  limits: { maxDurationSec: 3600, maxConcurrency: 4 },

  run: (input) =>
    Effect.gen(function* () {
      const day = isoDate(input.firedAt);

      // 1. Scope: the operator's estate. Listing is the attestation — this run
      //    never enumerates the installation, because a repo it was not told
      //    about is a repo nobody agreed it may propose against.
      //    Each entry is validated, not merely split. A repo name reaches the
      //    checkout as a path segment and as part of a command string, so an
      //    entry that is not `owner/name` is refused here rather than
      //    discovered by the container. One bad entry fails the sweep instead
      //    of being dropped: silently sweeping 3 of 4 repos is how a repo stops
      //    being audited without anyone being told.
      const rawRepos = parseList(yield* step("resolve-repos", () => config.get(REPOS_KEY)));
      const badRepos = rawRepos.filter((r) => parseRepo(r) === undefined);
      if (badRepos.length > 0) {
        return yield* Effect.fail(
          new StepFailed({
            step: "resolve-repos",
            cause: `${REPOS_KEY} has ${badRepos.length} entr${badRepos.length === 1 ? "y" : "ies"} that are not \`owner/name\`: ${badRepos.join(", ")}`,
          }),
        );
      }
      const repos = rawRepos;
      if (repos.length === 0) {
        yield* step("log-empty", () =>
          io.log("warn", `org-spec-audit: ${REPOS_KEY} is unset — nothing to sweep`),
        );
        return {
          reposSwept: 0,
          reposSkipped: 0,
          questionsRaised: 0,
          questionsAfterMerge: 0,
          questionsSuppressed: 0,
          prOpened: false,
        };
      }

      // The ref is validated for the same reason the repo names are: the
      // checkout interpolates it into a command string, so an unchecked value
      // is an unchecked command. Unset takes the default; set-and-unusable is
      // an error rather than a silent fall back to `main`, which would audit a
      // branch the operator did not ask for and report it as the one they did.
      const rawBase = yield* step("resolve-base", () => config.get(BASE_KEY));
      const baseBranch =
        rawBase === undefined || rawBase === null || rawBase.trim() === ""
          ? "main"
          : parseGitRef(rawBase);
      if (baseBranch === undefined) {
        return yield* Effect.fail(
          new StepFailed({
            step: "resolve-base",
            cause: `${BASE_KEY} is not a usable git ref`,
          }),
        );
      }

      // The one key with no default. Everything else here degrades to a sane
      // value; a write TARGET cannot, because the fallback for "the operator
      // did not say where to file this" is not a different repo — it is
      // stopping. Resolved before the sweep, not at the write, so a
      // misconfiguration is red on the first tick instead of after an hour of
      // model calls whose output has nowhere to go.
      const controlRepo = parseRepo(
        yield* step("resolve-control-repo", () => config.get(CONTROL_REPO_KEY)),
      );
      if (controlRepo === undefined) {
        return yield* Effect.fail(
          new StepFailed({
            step: "resolve-control-repo",
            cause: `${CONTROL_REPO_KEY} is unset or not \`owner/name\` — this run has no default control repo, and will not guess one`,
          }),
        );
      }

      const questionsDir = parseRepoRelativePath(
        yield* step("resolve-questions-dir", () => config.get(QUESTIONS_DIR_KEY)),
        QUESTIONS_DIR_DEFAULT,
      );
      if (questionsDir === undefined) {
        return yield* Effect.fail(
          new StepFailed({
            step: "resolve-questions-dir",
            cause: `${QUESTIONS_DIR_KEY} is not a repo-relative directory (no leading "/", no "..", no backslashes)`,
          }),
        );
      }

      const declinedPath = parseRepoRelativePath(
        yield* step("resolve-declined-path", () => config.get(DECLINED_PATH_KEY)),
        DECLINED_LEDGER_PATH,
      );
      if (declinedPath === undefined) {
        return yield* Effect.fail(
          new StepFailed({
            step: "resolve-declined-path",
            cause: `${DECLINED_PATH_KEY} is not a repo-relative path (no leading "/", no "..", no backslashes)`,
          }),
        );
      }

      const windowHours = parseWindowHours(
        yield* step("resolve-window", () => config.get(WINDOW_HOURS_KEY)),
      );

      // 2. The backend, under THIS run's namespace. A misconfigured backend
      //    fails loudly — an audit that silently answers nothing is worse than
      //    one that does not run.
      const resolved = yield* step("resolve-backend", () =>
        resolveBackend((k) => config.get(k), { namespace: NAMESPACE }),
      ).pipe(
        Effect.catchTag("BackendUnconfigured", (e) =>
          Effect.fail(
            new StepFailed({
              step: "resolve-backend",
              cause: `org-spec-audit backend "${e.backend}" misconfigured — set ${e.missing}`,
            }),
          ),
        ),
      );

      const promptOverride = yield* step("resolve-prompt", () => config.get(promptKey(NAMESPACE)));
      const systemPrompt = promptOverride ?? QUESTIONS_PROMPT_DEFAULT;

      // 3. Sweep. One repo's failure is logged and skipped — never poisons its
      //    siblings, because a partial digest is still worth reading.
      const outcomes = yield* Effect.forEach(
        repos,
        (repo) =>
          sweepRepo({ repo, baseBranch, windowHours, resolved, systemPrompt }).pipe(
            Effect.catchAll((err) => {
              const failure = describe(err);
              return io
                .log("warn", `org-spec-audit: skipped ${repo} — ${failure}`)
                .pipe(
                  Effect.as({ repo, skipped: true, failure, questions: [] } satisfies RepoOutcome),
                );
            }),
          ),
        { concurrency: 2 },
      );

      const raised = outcomes.flatMap((o) => o.questions);
      const merged = mergeAcrossRepos(raised);
      const swept = outcomes.filter((o) => !o.skipped).length;
      const skipped = outcomes.filter((o) => o.skipped).length;

      // 4. Empty means silent — no PR and, now, no notice. A digest that fires
      //    whether or not there is news is one people learn to skip, and that
      //    is far more expensive in a channel than in a repo: the day it does
      //    have something to say, nobody is reading.
      if (merged.length === 0) {
        yield* io.log("info", `org-spec-audit: ${swept} repo(s) swept, no open questions`);
        return {
          reposSwept: swept,
          reposSkipped: skipped,
          questionsRaised: raised.length,
          questionsAfterMerge: 0,
          questionsSuppressed: 0,
          prOpened: false,
        };
      }

      // 5. Suppression, BEFORE anything is proposed. A question the ledger
      //    declined is never asked again; one whose proposal a human closed
      //    unmerged waits out a cooldown dated from the close. Both reads fail
      //    OPEN and say so — a duplicate PR is a nuisance, a silently disabled
      //    loop is the failure this whole mechanism exists to prevent.
      const suppression = yield* step("check-suppression", () =>
        checkSuppression({
          keys: merged.map((q) => maintenanceKey(q.key)),
          // The ledger and the proposals live in the same control repo, so one
          // installation covers both reads.
          ledgerRepo: controlRepo,
          ledgerPath: declinedPath,
          headBranchPrefix: BRANCH_PREFIX,
          nowMs: input.firedAt,
        }),
      );
      const allowed = new Set(suppression.allowed);
      const proposed = merged.filter((q) => allowed.has(maintenanceKey(q.key)));

      // Every question suppressed is a *good* tick, and a silent one — there is
      // nothing new to ask. The count still lands in the output so a digest can
      // say "0 new, 3 suppressed" rather than implying a quiet estate.
      if (proposed.length === 0) {
        yield* io.log(
          "info",
          `org-spec-audit: ${merged.length} question(s), all suppressed — no PR opened`,
        );
        return {
          reposSwept: swept,
          reposSkipped: skipped,
          questionsRaised: raised.length,
          questionsAfterMerge: merged.length,
          questionsSuppressed: suppression.suppressed.length,
          prOpened: false,
        };
      }

      // 6. One control-plane PR against the configured control repo. The file
      //    it carries IS the message a Slack consumer posts — this run holds no
      //    Slack credential and never will.
      const message = renderMessage({
        day,
        merged: proposed,
        outcomes,
        raised: raised.length,
        suppression,
      });
      const result = yield* step("open-questions-pr", () =>
        github.openDraftPullRequest({
          repo: controlRepo,
          baseBranch,
          headBranch: `${BRANCH_PREFIX}${day}`,
          title: `docs(maintenance): open questions from the spec audit sweep (${day})`,
          body: renderPrBody({
            day,
            merged: proposed,
            outcomes,
            raised: raised.length,
            suppression,
            message,
            declinedPath,
          }),
          commitMessage: `docs(maintenance): spec audit open questions (${day})\n\nGenerated by flare-dispatch org-spec-audit.`,
          files: [
            {
              path: `${questionsDir}/${day}.md`,
              content: message,
            },
          ],
        }),
      );

      // 6. Say it out loud. The same `message`, verbatim — the file and the
      //    announcement are one rendering on purpose, so nobody has to ask
      //    which of two wordings is the real one. No markup is built here:
      //    `text` is data the receiver escapes, and the PR link rides in the
      //    typed `links` field precisely because markup inside `text` would be
      //    escaped along with everything else.
      //
      //    `dedupeKey` is the day, which is also this run's schedule
      //    idempotency key. Deterministic per (run, day) and free of any clock
      //    read, so a retried step re-sends bytes the receiver has already
      //    claimed and gets a 409 instead of posting the digest twice.
      yield* step("publish-notice", () =>
        notice.publish({
          useCase: NOTICE_USE_CASE,
          dedupeKey: day,
          text: message,
          links: [{ url: result.url, label: "the questions PR" }],
        }),
      );

      yield* io.log(
        "info",
        `org-spec-audit: ${proposed.length} question(s) from ${raised.length} raised (${suppression.suppressed.length} suppressed) — ${result.created ? "opened" : "updated"} PR #${result.number}`,
      );

      return {
        reposSwept: swept,
        reposSkipped: skipped,
        questionsRaised: raised.length,
        questionsAfterMerge: merged.length,
        questionsSuppressed: suppression.suppressed.length,
        prOpened: result.created,
      };
    }),
});

// ---------------------------------------------------------------------------

/** One question as raised by one repo, before the cross-repo merge. */
type RaisedQuestion = (typeof AuditQuestions.Type)["questions"][number] & {
  readonly repo: string;
};

/** The same question after merging every repo that raised it. */
export type MergedQuestion = {
  readonly key: string;
  readonly group: Group;
  readonly question: string;
  readonly assumption: string;
  /** Every repo that raised it, with the spec that did — the merge's whole payload. */
  readonly sources: readonly { readonly repo: string; readonly specPath: string }[];
  readonly evidence: string;
};

type RepoOutcome = {
  readonly repo: string;
  /** True when the repo produced no questions — dormant, no specs, or failed. */
  readonly skipped: boolean;
  /**
   * Why the repo failed, when it did. Absent for a repo that was legitimately
   * quiet.
   *
   * A failure and a dormant week both end the sweep early, and reporting them
   * as one bucket makes an outage read as good news: a model rate-limit across
   * the whole estate renders as "every repo unchanged", which is the sentence a
   * reader is least likely to question. The digest separates them.
   */
  readonly failure?: string;
  readonly questions: readonly RaisedQuestion[];
};

type SweepArgs = {
  readonly repo: string;
  readonly baseBranch: string;
  readonly windowHours: number;
  readonly resolved: { backend: string; model: string; mode: "tools" | "json" };
  readonly systemPrompt: string;
};

/** Read one repo's specs and ask what they cannot settle. */
const sweepRepo = (args: SweepArgs) =>
  Effect.gen(function* () {
    const { container, dir } = yield* step(`checkout-${args.repo}`, () =>
      workspace({ repo: args.repo, sha: args.baseBranch }),
    );

    // The deterministic exit, before a single model call: a repo nobody has
    // touched in the window cannot have drifted since the last sweep. Most
    // repos on most days end here, and this is why the sweep is affordable.
    //
    // The exit code is checked, not just the output: an empty stdout from a
    // `git` that FAILED is indistinguishable from a quiet week, and silently
    // skipping a repo because the tooling broke is the same failure as a radar
    // that sees nothing. A broken gather fails the repo loudly instead.
    const log = yield* step(`gather-log-${args.repo}`, () =>
      shRun(container, dir, logScript(args.windowHours)),
    );
    if (log.exitCode !== 0) {
      return yield* Effect.fail(
        new StepFailed({
          step: `gather-log-${args.repo}`,
          cause: `git log exited ${log.exitCode}: ${log.stderr.slice(0, 200)}`,
        }),
      );
    }
    const recentLog = log.stdout;
    if (recentLog.trim().length === 0) {
      yield* io.log("info", `org-spec-audit: ${args.repo} — no commits in window, skipped`);
      return { repo: args.repo, skipped: true, questions: [] } satisfies RepoOutcome;
    }

    const specs = yield* step(`gather-specs-${args.repo}`, () =>
      shRun(container, dir, SPECS_SCRIPT),
    );
    if (specs.exitCode !== 0) {
      return yield* Effect.fail(
        new StepFailed({
          step: `gather-specs-${args.repo}`,
          cause: `spec gather exited ${specs.exitCode}: ${specs.stderr.slice(0, 200)}`,
        }),
      );
    }
    const specsText = specs.stdout.slice(0, MAX_SPECS_CHARS);
    if (specsText.trim().length === 0) {
      // No specs/ — nothing to audit. Worth a line, not a question: a product
      // repo with no specs is a finding a human already knows how to read.
      yield* io.log("info", `org-spec-audit: ${args.repo} — no specs/`);
      return { repo: args.repo, skipped: true, questions: [] } satisfies RepoOutcome;
    }

    // An empty tree is not benign here: it is the half of the prompt the model
    // contradicts the specs WITH, so a silent failure leaves it agreeing with
    // every spec and reporting nothing.
    const treeResult = yield* step(`gather-tree-${args.repo}`, () =>
      shRun(container, dir, TREE_SCRIPT),
    );
    if (treeResult.exitCode !== 0) {
      return yield* Effect.fail(
        new StepFailed({
          step: `gather-tree-${args.repo}`,
          cause: `tree gather exited ${treeResult.exitCode}: ${treeResult.stderr.slice(0, 200)}`,
        }),
      );
    }
    const tree = treeResult.stdout.slice(0, MAX_TREE_CHARS);

    const found = yield* step(`ask-${args.repo}`, () =>
      completeStructured({
        backend: args.resolved.backend,
        model: args.resolved.model,
        mode: args.resolved.mode,
        system: args.systemPrompt,
        userBody: renderUserBody({ repo: args.repo, specsText, tree, recentLog }),
        jsonContract: QUESTIONS_JSON_CONTRACT,
        schema: AuditQuestions,
        toolName: "report_open_questions",
        toolDescription: "Report the spec divergences that need a human answer (possibly none).",
        surface: "org-spec-audit",
        maxTokens: QUESTIONS_MAX_TOKENS,
      }),
    );

    return {
      repo: args.repo,
      skipped: false,
      questions: found.questions.map((q) => ({ ...q, repo: args.repo })),
    } satisfies RepoOutcome;
  });

/**
 * Merge the same question across repos — the reason this sweeps.
 *
 * Deterministic and model-free: normalize the key, keep the first phrasing, and
 * accumulate every repo that raised it. Answering the merged line closes it
 * everywhere at once.
 */
export const mergeAcrossRepos = (raised: readonly RaisedQuestion[]): readonly MergedQuestion[] => {
  const byKey = new Map<string, MergedQuestion>();

  for (const q of raised) {
    const k = normalizeKey(q.key, q.question);
    const existing = byKey.get(k);
    const source = { repo: q.repo, specPath: oneLine(q.specPath) };

    if (existing === undefined) {
      byKey.set(k, {
        key: k,
        group: q.group,
        question: oneLine(q.question),
        assumption: oneLine(q.assumption),
        sources: [source],
        evidence: oneLine(q.evidence),
      });
      continue;
    }

    // Same repo raising the same key twice is one question, not two.
    if (existing.sources.some((s) => s.repo === source.repo && s.specPath === source.specPath)) {
      continue;
    }
    byKey.set(k, { ...existing, sources: [...existing.sources, source] });
  }

  // Most-shared first, counting distinct REPOS rather than sources. One repo
  // raising the same question from two spec files is still one repo asking;
  // ranking by source count lets it outrank a question two repos genuinely
  // share, which inverts the merge's entire purpose.
  return [...byKey.values()].sort((a, b) => distinctRepos(b) - distinctRepos(a));
};

/** How many distinct repos raised a merged question. */
const distinctRepos = (q: MergedQuestion): number => new Set(q.sources.map((s) => s.repo)).size;

/**
 * Control, C1, zero-width and bidi-override characters — stripped, not escaped.
 *
 * They have no legitimate place in a question, and a bidi override renders text
 * as the reverse of what the file literally says, which escaping would
 * faithfully preserve. The tab/newline/CR range is deliberately absent: those
 * are `\s`, and the collapse in {@link oneLine} turns them into a space rather
 * than deleting them, so a newline between two words stays a word boundary.
 */
const INVISIBLE =
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point here: they are what gets stripped from untrusted model prose
  /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069]/g;

/**
 * Collapse a model-supplied string onto one line.
 *
 * Every model field is rendered inside a markdown list item beginning `- ` or
 * `  - `, so a field that cannot contain a newline can never *start* a line of
 * the PR body — and that is the whole defence. The suppression reader picks up
 * `maintenance-key: <key>` from a line-anchored match anywhere in the body, not
 * only from the trailer block, so emitting the authentic trailers first stops
 * them being shadowed but does nothing about a second key registered further
 * down. Evidence containing a newline followed by `maintenance-key: other/thing`
 * would otherwise register a key this PR never proposed, and closing the PR
 * would then cool an unrelated question for the whole cooldown window.
 *
 * Collapsing rather than escaping keeps the digest readable and costs nothing
 * real: the prompt already contracts each of these fields to a single sentence.
 */
const oneLine = (raw: string): string =>
  raw.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();

/**
 * The longest question-key that survives the round trip.
 *
 * A key is published as `maintenance-key: <namespace>/<key>`, and the reader
 * that parses those lines drops any whole key over 200 characters. A key it
 * drops is strictly worse than a short one: the question is still proposed and
 * still written into the PR body, but nothing can ever record it as declined,
 * so every tick re-proposes it forever. The namespace and its separator come
 * out of the same budget, so they are subtracted rather than assumed.
 */
const MAX_KEY_CHARS = 200 - (NAMESPACE.length + 1);

/** Lowercase, hyphen-separated slug of an arbitrary string. */
const slugify = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Lowercase slug; falls back to the question text when the model's key is junk.
 *
 * The cap applies to whichever branch produced the slug. It used to bound only
 * the fallback, which left the branch actually taken in the common case — the
 * model's own key — unbounded, and a long one silently unreadable downstream.
 */
const normalizeKey = (key: string, question: string): string => {
  const slug = slugify(key);
  const chosen = slug.length >= 3 ? slug : slugify(question).slice(0, 60);
  return chosen.slice(0, MAX_KEY_CHARS).replace(/-+$/g, "");
};

/** `window-hours` as a positive integer, falling back to the default. */
export const parseWindowHours = (raw: string | undefined | null): number => {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : WINDOW_HOURS_DEFAULT;
};

// --- In-container gather scripts (plain `git`, no extra CLI) -----------------

/**
 * `git rev-parse` guard prefixed to every gather script.
 *
 * Each gather ends in a pipe, and a pipeline's exit status is its LAST
 * command's — `head` succeeds whether or not the `git` feeding it did, so the
 * exit code alone cannot distinguish "no specs" from "not a repo". Asserting
 * the checkout up front restores that distinction without giving up streaming
 * (`set -o pipefail` is not POSIX `sh`, and buffering the output to inspect
 * `git`'s status would reintroduce exactly the unbounded read the cap removes).
 */
const REQUIRE_REPO = `git rev-parse --git-dir >/dev/null 2>&1 || exit 1`;

/**
 * Concatenate every tracked spec markdown with a path delimiter, bounded.
 *
 * The `head -c` is the real cap, not a duplicate of the `slice` at the call
 * site. Truncating in TypeScript only bounds what reaches the *model* — the
 * container has by then already `cat`-ed every spec in the repo and streamed
 * the whole thing back, so an estate with large specs pays the memory, the
 * transfer, and the time regardless of a limit applied afterwards. Capping in
 * the pipeline makes `head` close the pipe and the loop stop reading.
 *
 * Both limits stay: this one is BYTES, the caller's `slice` is UTF-16 code
 * units, so neither subsumes the other. A multi-byte character straddling the
 * cut leaves a partial sequence at the tail, which is acceptable in a prompt.
 */
const SPECS_SCRIPT = `${REQUIRE_REPO}; { for f in $(git ls-files 'specs/*.md' 'specs/**/*.md'); do printf '\\n===FILE %s===\\n' "$f"; cat "$f"; done; } | head -c ${MAX_SPECS_CHARS}`;
/** The repo's tracked file tree — the signal for which paths actually exist. */
const TREE_SCRIPT = `${REQUIRE_REPO}; git ls-files | head -800`;
/** Commits in the window. Empty output is the deterministic exit. */
const logScript = (hours: number): string => `git log --oneline --since="${hours} hours ago" -n 40`;

/** Run a `sh -lc <script>` in the container and return the full result. */
const shRun = (container: Container, cwd: string, script: string) =>
  sandbox.exec({ container, cwd, command: ["sh", "-lc", script] });

// --- Prompt + message rendering ----------------------------------------------

/** The compact JSON shape the model must emit (engine appends it in json mode). */
const QUESTIONS_JSON_CONTRACT = `{"questions":[{"group":"decide"|"confirm"|"own"|"retire","question":string,"evidence":string,"specPath":string,"assumption":string,"key":string}]}`;

/** The domain body of the user message (the engine appends the per-mode framing). */
const renderUserBody = (ctx: {
  repo: string;
  specsText: string;
  tree: string;
  recentLog: string;
}): string =>
  [
    `Repository: ${ctx.repo}`,
    "",
    "## specs/ (full contents)",
    ctx.specsText,
    "",
    "## Repo file tree (tracked paths)",
    ctx.tree,
    "",
    "## Recent commits",
    ctx.recentLog,
  ].join("\n");

const MARKER = "<!-- flare-dispatch: org-spec-audit -->";

type RenderArgs = {
  readonly day: string;
  /** The questions actually being proposed — suppressed ones are already out. */
  readonly merged: readonly MergedQuestion[];
  readonly outcomes: readonly RepoOutcome[];
  readonly raised: number;
  /** What suppression kept out, and whether either read degraded. */
  readonly suppression: SuppressionReport;
};

/**
 * The file the PR carries — and the message a Slack consumer posts, verbatim.
 *
 * Written as GitHub markdown, not Slack mrkdwn: the canonical artifact is the
 * reviewed file in git, and the Slack twin is derived at send time by whoever
 * holds the token.
 */
export const renderMessage = (args: RenderArgs): string => {
  const swept = args.outcomes.filter((o) => !o.skipped).map((o) => o.repo);
  const failed = args.outcomes.filter((o) => o.failure !== undefined);
  const quiet = args.outcomes
    .filter((o) => o.skipped && o.failure === undefined)
    .map((o) => o.repo);
  const dropped = countDropped(args.merged);

  const lines: string[] = [
    `# Spec audit — ${args.day}`,
    "",
    `${swept.length} repo(s) swept · ${quiet.length} unchanged or without specs · ` +
      `${failed.length} failed · ${args.merged.length} question(s) from ${args.raised} raised` +
      (args.suppression.suppressed.length > 0
        ? ` · ${args.suppression.suppressed.length} suppressed`
        : ""),
    "",
    // Immediately after the headline count, not in a footer: a reader who sees
    // a short list has to see WHY it is short in the same glance, or a
    // suppressed question reads as a problem that went away.
    ...renderSuppressionNote(args.suppression),
  ];

  // Above the questions, not below them: a sweep that failed on half the estate
  // is a caveat on everything that follows, and a reader who stops after the
  // first screen has to have seen it.
  if (failed.length > 0) {
    lines.push(
      `> ⚠️ ${failed.length} repo(s) could not be swept — the questions below are from the rest of the estate, not all of it.`,
      "",
    );
  }

  for (const group of GROUPS) {
    const inGroup = args.merged.filter((q) => q.group === group);
    if (inGroup.length === 0) continue;

    lines.push(`## ${GROUP_HEADING[group]} (${inGroup.length})`, "");
    for (const q of inGroup.slice(0, PER_GROUP_CAP)) {
      lines.push(
        `- **${q.question}**`,
        `  - ${q.evidence}`,
        `  - raised by: ${q.sources.map((s) => `\`${s.repo}\` (${s.specPath})`).join(" · ")}`,
        `  - if nobody answers: ${q.assumption}`,
      );
    }
    if (inGroup.length > PER_GROUP_CAP) {
      lines.push(`- _${inGroup.length - PER_GROUP_CAP} more in this group, not shown._`);
    }
    lines.push("");
  }

  lines.push(
    "---",
    "",
    `Swept: ${swept.length > 0 ? swept.map((r) => `\`${r}\``).join(" · ") : "none"}`,
    `Unchanged or no \`specs/\`: ${quiet.length > 0 ? quiet.map((r) => `\`${r}\``).join(" · ") : "none"}`,
    `Failed: ${failed.length > 0 ? failed.map((o) => `\`${o.repo}\` (${o.failure})`).join(" · ") : "none"}`,
    dropped > 0 ? `Below the per-group cap: ${dropped}` : "Nothing dropped by the cap.",
  );

  return `${lines.join("\n")}\n`;
};

/** How many merged questions the per-group cap keeps out of the message. */
const countDropped = (merged: readonly MergedQuestion[]): number =>
  GROUPS.reduce((total, group) => {
    const n = merged.filter((q) => q.group === group).length;
    return total + Math.max(0, n - PER_GROUP_CAP);
  }, 0);

/**
 * The PR body. Carries the loop's machine-readable lines plus the message
 * itself, so a reviewer decides without opening the diff.
 *
 * **One `maintenance-key` line per question, not one per PR.** The key is what
 * a later tick matches against the ledger and against this PR once it is
 * closed, so it has to name the thing a human declines — a question. A dated
 * per-PR key would be unique every day and suppress nothing, ever.
 */
const renderPrBody = (
  args: RenderArgs & { message: string; declinedPath: string },
): string =>
  [
    "### Spec audit — the questions the sweep could not answer",
    "",
    "> 🤖 Draft opened by `flare-dispatch/org-spec-audit`. These are divergences where *which side is right* is a judgment nobody has made yet — not drift (`spec-drift-pr` proposes those). Answer in the thread or edit the file; merging records the answers.",
    "",
    `> Closing this unmerged suppresses every key below for 30 days. To suppress one permanently, add its key to \`${args.declinedPath}\` with a reason.`,
    "",
    // The trailers precede the message, and that order is load-bearing. Every
    // line of `message` below is model output derived from the contents of the
    // swept repos, so a spec crafted to make the model emit `auto-merge: yes`
    // would, with the trailers last, put a spoofed value ahead of the real one
    // for any consumer that reads the first match. Emitted first, the authentic
    // trailers win and anything the model echoes is inert text further down.
    ...args.merged.map((q) => `maintenance-key: ${maintenanceKey(q.key)}`),
    `swept: ${
      args.outcomes
        .filter((o) => !o.skipped)
        .map((o) => o.repo)
        .join(", ") || "none"
    }`,
    `suppressed: ${args.suppression.suppressed.length}`,
    "auto-merge: never (specs are a sensitive path)",
    MARKER,
    "",
    "---",
    "",
    args.message,
  ].join("\n");

/** The errors `sweepRepo`'s `catchAll` knows how to describe precisely. */
type CaughtError =
  | BackendUnconfigured
  | ModelCallFailed
  | StructuredOutputInvalid
  | GitHubApiError
  | CheckoutFailed
  | StepFailed;

/**
 * Human-readable one-liner for any caught error (model / git / GitHub).
 *
 * `CheckoutFailed` is matched explicitly and its `cause` deliberately dropped.
 * The clone URL carries a GitHub App installation token
 * (`https://x-access-token:<token>@github.com/...`), the cause is typed
 * `unknown` so it serializes whole, and this string is both logged and written
 * into a PR body. The repo and ref are the whole diagnosis anyway — the tail of
 * the `git` error adds nothing that is worth carrying a credential to get.
 */
const describe = (err: unknown): string =>
  Match.value(err as CaughtError).pipe(
    Match.tag(
      "BackendUnconfigured",
      (e) => `backend "${e.backend}" misconfigured — set ${e.missing}`,
    ),
    Match.tag("ModelCallFailed", (e) => `model call failed (${e.reason}): ${e.message}`),
    Match.tag("StructuredOutputInvalid", (e) => `unparseable model output (${e.reason})`),
    Match.tag("GitHubApiError", (e) => `GitHub API ${e.status} (${e.reason})`),
    Match.tag("CheckoutFailed", (e) => `checkout of ${e.repo} at ${e.sha} failed`),
    Match.tag("StepFailed", (e) => `${e.step}: ${e.cause}`),
    // Deliberately not `JSON.stringify(err)`: an unrecognised error is exactly
    // the case where nothing is known about what its fields hold.
    Match.orElse(() => (err instanceof Error ? err.message : "unrecognised failure")),
  );
