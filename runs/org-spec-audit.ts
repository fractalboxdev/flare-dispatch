// Run: scheduled estate-wide spec audit → the open questions, grouped
//
// A Schedule-mode run that sweeps every configured repo, reads each one's
// `specs/` against its tree, and collects the divergences that CANNOT be
// reconciled automatically — the ones where *which side is right* is a
// judgment nobody has made yet. It deduplicates them across the estate and
// files each one as ONE GITHUB ISSUE in the control repo.
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
// reason this sweeps instead of running per repo, and it is why every question
// lands in ONE control repo rather than in the repo that raised it.
//
// --- One question, one issue — and why it is not a daily file ---------------
//
// This run shipped filing a dated `<date>.md` in a draft PR: every question it
// found that day, rendered fresh. Two sweeps two days apart then asked three of
// the same questions twice, two of them under a BYTE-IDENTICAL
// `maintenance-key` (`org#147`, `org#148`).
//
// An identical key that re-proposes rules out the obvious cause and leaves the
// real one. The ledger only ever remembered *no*: both suppression rules key
// off a TERMINATED proposal — a decline recorded in the ledger, or a PR closed
// unmerged — and the first PR was neither. It was open, unanswered, sitting in
// the queue, which the design read as no signal at all.
//
// So the unit is now the question, and the artifact is a GitHub issue:
//
//   open    — asked, unanswered → this run writes NOTHING. Silence is correct.
//   closed  — answered, or declined → never filed again, and never reopened.
//   absent  — new → filed.
//
// That collapses the whole apparatus into one field. `open` is a first-class
// answer to "have I raised this?", which no ledger of declines could express,
// and a decline stops needing a second file a human maintains by hand.
//
// Two rules follow, and both are load-bearing:
//
//   * NEVER reopen and never re-announce. A run that reopens an issue argues
//     with the person who closed it, and a daily "still open" comment is the
//     daily file again in miniature. How long a decision has gone unmade is
//     already legible from the issue's own age.
//   * The dedup read fails CLOSED (below), inverting the suppression
//     primitive's posture on purpose.
//
// --- Delivery: the issue is the record, the notice is the announcement -------
//
// This run does not post to Slack, and must not be given a way to. Slack bot
// tokens live with the Slack ingress and stay there (see
// `apps/dispatcher/src/slack-notify.ts`) — a cron run holding a workspace-write
// credential is how a token ends up somewhere nobody meant it to be.
//
// The issues are the durable record; answering in a thread and closing is how a
// question ends. `notice.publish` then announces the DELTA — filed today, how
// many stand open, what the cap held — to the `notice` capability, which names
// a use case and nothing else; the Slack ingress resolves that to a room and
// posts it with the token it already holds.
//
// The delta matters as much as the medium. The old message was the day's whole
// file, so its length tracked the sweep rather than the news and a reader who
// had already seen eleven questions was shown eleven questions again. Now most
// days say nothing, and "nothing" means nothing CHANGED rather than nothing
// found — with the open-question count one GitHub query away for anyone who
// wants to tell those apart.
//
// --- Suppression: two reads, and only one may fail open ----------------------
//
// The issue set is the memory. Before filing, the run reads every issue in the
// control repo carrying the questions label, in ANY state, and matches on the
// `maintenance-key: org-spec-audit/<question-key>` line in each body.
//
// That read **fails closed**, which reverses what this run used to do. When one
// PR a day carried every question, an unreadable ledger cost one duplicate PR,
// so failing open was right and failing closed would have silenced the loop.
// Now an unreadable issue set costs a duplicate of EVERY question at once — so
// a sweep that cannot enumerate what it has already asked files nothing. It
// loses a day and no facts, because the questions are re-derived tomorrow.
// Same reason the read is `state: "all"`, un-windowed, and `strict` (a list the
// page ceiling cut short answers "not filed" for everything it never reached).
//
// The declines ledger (`declined.jsonl`) is the PRE-EMPTIVE half and still
// fails open: a key there is never filed at all, and if the file cannot be read
// the run files anyway, because the cost is one issue a human closes — and that
// close then suppresses it permanently, which is a better end state than a loop
// silently disabled by an unreachable file. The PR-history half retires with
// the PR: this run opens none, so no cooldown is computed from one.
//
// --- CONFIG the operator sets (out of band) ---------------------------------
//
// Every value that names an operator's own estate is a key, not a constant.
// This run is generic machinery — which repos it reads, which repo it files
// into, and what it labels the issues are the operator's business and live in
// their config, never in this file. A default that names somebody's repo is a
// default that opens issues on it.
//
// Unset keys are not uniform, and the split is deliberate. An unset `repos` is
// a run nobody has pointed at anything yet: it warns and no-ops, because on a
// fresh install the cron fires before the estate is configured and a daily red
// tick trains operators to ignore the check. An unset `control-repo` is the
// opposite — the sweep would do all its work with nowhere to put the answer —
// so that one fails the run loudly.
//
//   CONFIG_KV  org-spec-audit.repos              comma/space-separated `owner/name` estate to sweep (optional — unset disables the sweep)
//   CONFIG_KV  org-spec-audit.base               base branch to read (default "main")
//   CONFIG_KV  org-spec-audit.control-repo       `owner/name` the question issues land in (REQUIRED — no default)
//   CONFIG_KV  org-spec-audit.questions-label    label marking a question issue (default "maintenance:open-question")
//   CONFIG_KV  org-spec-audit.lane-label-prefix  prefix + group → the lane label (default "question:")
//   CONFIG_KV  org-spec-audit.max-new-questions  issues filed per sweep; the rest are counted (default 5)
//   CONFIG_KV  org-spec-audit.declined-path      repo-relative declines ledger (default "maintenance/declined.jsonl")
//   CONFIG_KV  org-spec-audit.window-hours       skip a repo with no commits in this window (default "26")
//   CONFIG_KV  org-spec-audit.backend            "workers-ai" | "anthropic" | "bedrock" (default workers-ai)
//   CONFIG_KV  org-spec-audit.prompt             (optional) override the question-detection system prompt
//   CONFIG_KV  org-spec-audit.workers-ai.model   model id
//   CONFIG_KV  org-spec-audit.workers-ai.mode    "tools" | "json" (default "tools")
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
import type { CheckoutFailed, GitHubApiError, IssueRef } from "@fractalboxdev/flare-dispatch-core";
import {
  checkSuppression,
  DECLINED_LEDGER_PATH,
  isoDate,
  parseGitRef,
  parseList,
  parseRepo,
  renderSuppressionNote,
  resolveControlRepo,
  resolveRepoRelativePath,
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
const QUESTIONS_LABEL_KEY = key("questions-label");
const LANE_LABEL_PREFIX_KEY = key("lane-label-prefix");
const MAX_NEW_QUESTIONS_KEY = key("max-new-questions");
const DECLINED_PATH_KEY = key("declined-path");
const WINDOW_HOURS_KEY = key("window-hours");

/**
 * The label every question issue carries — the ledger's INDEX.
 *
 * Machine state, not a human affordance: the dedup read filters on it to find
 * every question this run has ever asked, so a question whose label someone
 * removes becomes fileable again. The lane labels below are the opposite —
 * nothing matches on them, so they are safe to retriage by hand.
 */
const QUESTIONS_LABEL_DEFAULT = "maintenance:open-question";
const LANE_LABEL_PREFIX_DEFAULT = "question:";

/**
 * How many issues one sweep may open.
 *
 * A first sweep of a widened estate can find twenty, and twenty new issues at
 * 05:45 is a wall rather than a digest. What the cap holds back is counted and
 * named in the notice — never dropped silently, because a shorter list that
 * does not say it is shorter reads as fewer problems — and files on the next
 * sweep, which finds it un-filed and therefore fresh.
 */
const MAX_NEW_QUESTIONS_DEFAULT = 5;

/** The `maintenance-key` namespace every question is suppressed by. */
const MAINTENANCE_SOURCE = "org-spec-audit";

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

// A per-group rendering cap used to live here, because the message carried every
// standing question and a long group buried the rest. The notice now lists only
// what was FILED this tick, which `max-new-questions` already bounds — one cap
// instead of two, and the one that bounds the writes is the one that matters.

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
       *
       * Stable across DAYS as well as repos, which is the harder half and was
       * once wrong here: the same question arrived as `authorize-pipeline-dags`
       * one day and `adopt-pipeline-dags` the next, matching nothing. The prompt
       * asks for a noun phrase for that reason, and `reconcileKeys` catches what
       * prompt discipline misses — a rule with no mechanism behind it is a rule
       * that holds until the model rephrases.
       */
      key: Schema.String,
    }),
  ),
});

/**
 * One verdict per newly-minted key: the key already on file that it means the
 * same question as, or `""` for none.
 *
 * Deliberately not "is this a duplicate, yes/no" — the model has to NAME the
 * question it thinks this duplicates, and that name is then checked against the
 * set actually read from the control repo. A key it invents matches nothing and
 * the question gets filed, which is the safe direction: the cost of a missed
 * match is one duplicate issue a human closes, and the cost of an accepted
 * hallucination is a question silently never asked.
 */
const KeyReconciliation = Schema.Struct({
  matches: Schema.Array(
    Schema.Struct({
      /** The key this sweep minted, echoed back so the mapping is unambiguous. */
      minted: Schema.String,
      /** An existing key from the list given, or `""` when this question is new. */
      existing: Schema.String,
    }),
  ),
});

const RECONCILE_PROMPT = `You are matching newly-raised questions against questions already on file.

For each NEW question you are given, decide whether it is THE SAME QUESTION as
one of the questions already on file — the same decision, needing the same
answer, however differently it is worded. Wording, framing and the verb used
carry no weight; the subject and the decision it needs are what matter.

Rules:
- Answer with the existing key when it is the same question, and "" when it is
  not. Every new key you were given gets exactly one row.
- Only ever answer with a key from the on-file list, verbatim. Never invent one,
  never adjust one, and never answer with a new key.
- Narrower or broader is NOT the same question. "Should we support DAGs" and
  "should we deprecate the linear model" need different answers; keep them apart.
- When you are unsure, answer "". A duplicate question costs a human one click;
  a question wrongly matched away is never asked again.`;

const RECONCILE_JSON_CONTRACT = `{"matches":[{"minted":string,"existing":string}]}`;
const RECONCILE_MAX_TOKENS = 1024;

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
- The key is a short lowercase slug NAMING THE SUBJECT of the question, as a
  noun phrase and never a verb phrase: "pipeline-dags", not
  "adopt-pipeline-dags", "authorize-pipeline-dags" or "should-we-adopt-dags". A
  verb encodes the action being proposed, which changes with how you phrase it;
  the subject of the question does not. No repo name in it, so the same question
  asked in two repos merges into one line.
- Report nothing rather than padding. An empty array is a good answer.`;

const Input = Schema.Struct({
  firedAt: Schema.Number,
});

const Output = Schema.Struct({
  reposSwept: Schema.Number,
  reposSkipped: Schema.Number,
  questionsRaised: Schema.Number,
  questionsAfterMerge: Schema.Number,
  /**
   * Merged questions that already have an issue, in any state.
   *
   * The number this whole design exists to make non-zero on a steady estate: on
   * a quiet week every question the sweep raises is one already on file, and the
   * correct output is no writes at all.
   */
  questionsAlreadyFiled: Schema.Number,
  /** Merged questions the declines ledger kept from being filed. */
  questionsSuppressed: Schema.Number,
  /** Issues actually opened this tick. */
  questionsFiled: Schema.Number,
  /** Fresh questions the per-sweep cap held back — they file on the next tick. */
  questionsHeldByCap: Schema.Number,
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
          questionsAlreadyFiled: 0,
          questionsSuppressed: 0,
          questionsFiled: 0,
          questionsHeldByCap: 0,
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
      // model calls whose output has nowhere to go. See
      // `primitives/control-plane` for the rule and the failure text.
      const controlRepo = yield* resolveControlRepo(CONTROL_REPO_KEY);
      const declinedPath = yield* resolveRepoRelativePath(DECLINED_PATH_KEY, DECLINED_LEDGER_PATH);

      // Set-and-unusable fails; unset takes the default. A label that cannot be
      // both filtered on and applied would break dedup silently — see
      // `parseLabel`.
      const questionsLabel = parseLabel(
        yield* step("resolve-questions-label", () => config.get(QUESTIONS_LABEL_KEY)),
        QUESTIONS_LABEL_DEFAULT,
      );
      if (questionsLabel === undefined) {
        return yield* Effect.fail(
          new StepFailed({
            step: "resolve-questions-label",
            cause: `${QUESTIONS_LABEL_KEY} is not a usable GitHub label (no comma, max ${LABEL_MAX_CHARS} chars)`,
          }),
        );
      }
      const lanePrefix = parseLabel(
        yield* step("resolve-lane-prefix", () => config.get(LANE_LABEL_PREFIX_KEY)),
        LANE_LABEL_PREFIX_DEFAULT,
      );
      if (lanePrefix === undefined) {
        return yield* Effect.fail(
          new StepFailed({
            step: "resolve-lane-prefix",
            cause: `${LANE_LABEL_PREFIX_KEY} is not a usable GitHub label prefix (no comma, max ${LABEL_MAX_CHARS} chars)`,
          }),
        );
      }
      const maxNew = parsePositiveInt(
        yield* step("resolve-max-new", () => config.get(MAX_NEW_QUESTIONS_KEY)),
        MAX_NEW_QUESTIONS_DEFAULT,
      );

      const windowHours = parseWindowHours(
        yield* step("resolve-window", () => config.get(WINDOW_HOURS_KEY)),
      );

      // 1b. The ledger read — BEFORE the sweep, not after.
      //
      //     It is one cheap call whose failure ends the tick, so it belongs
      //     where the other deterministic exits are (§7). Reading it after the
      //     sweep would mean paying for an estate's worth of model calls and
      //     then discarding every one of them.
      //
      //     `state: "all"` because a question answered a year ago must still
      //     suppress; un-windowed for the same reason; `strict` because a list
      //     the page ceiling cut short answers "not filed" for everything it
      //     never reached, and this read's answer to that question is what
      //     decides whether anything is written.
      //
      //     No `catchAll`. A failure here fails the run, which is the whole
      //     inversion: better a day with no questions filed than a day that
      //     files a duplicate of every question on file.
      const onFile = yield* step("read-question-ledger", () =>
        github.issues({
          repo: controlRepo,
          state: "all",
          labels: [questionsLabel],
          strict: true,
        }),
      );
      const filed = indexFiledQuestions(onFile);
      yield* io.log(
        "info",
        `org-spec-audit: ${filed.size} question(s) already on file in ${controlRepo} ` +
          `(${onFile.filter((i) => i.state === "open").length} open)`,
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

      // 4. Empty means silent — no issue and no notice. A digest that fires
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
          questionsAlreadyFiled: 0,
          questionsSuppressed: 0,
          questionsFiled: 0,
          questionsHeldByCap: 0,
        };
      }

      // 5. Which of today's questions are already on file? Exact keys first,
      //    deterministically and for free — a matching key IS the same question
      //    and needs nothing to confirm it.
      const exact = merged.filter((q) => filed.has(maintenanceKey(q.key)));
      const residue = merged.filter((q) => !filed.has(maintenanceKey(q.key)));

      // 6. Then reconcile the residue, ONCE, for the whole batch. A key is
      //    minted from prose, so two sweeps can name one question twice —
      //    `authorize-pipeline-dags` and `adopt-pipeline-dags` were the same
      //    question on consecutive days. Asking a model to MATCH against what is
      //    on file is far more stable than asking it to invent the same slug
      //    twice, and it is one call for the batch rather than one per question.
      //
      //    Skipped entirely when there is nothing on file to match against —
      //    on a fresh control repo every question is new by construction.
      const matchRows =
        residue.length > 0 && filed.size > 0
          ? yield* step("reconcile-keys", () =>
              reconcileKeys({
                residue,
                onFile: [...filed.values()],
                resolved,
              }),
            ).pipe(
              // A model that cannot answer must not be able to file duplicates
              // OR to suppress questions: falling back to "nothing matched"
              // files the residue, which is the direction whose worst case is a
              // human closing an issue.
              Effect.catchAll((err) =>
                io
                  .log(
                    "warn",
                    `org-spec-audit: key reconciliation failed (${describe(err)}) — treating all ${residue.length} as new`,
                  )
                  .pipe(Effect.as([] as readonly KeyMatch[])),
              ),
            )
          : ([] as readonly KeyMatch[]);
      const reconciled = new Map(matchRows.map((m) => [m.minted, m.existing]));

      const alreadyFiled = [...exact, ...residue.filter((q) => reconciled.has(q.key))];
      const unfiled = residue.filter((q) => !reconciled.has(q.key));

      for (const q of residue) {
        const match = reconciled.get(q.key);
        if (match !== undefined) {
          yield* io.log(
            "info",
            `org-spec-audit: "${q.key}" reconciled onto ${match} — already asked, not re-filed`,
          );
        }
      }

      // 7. The declines ledger — the pre-emptive half, and the only read here
      //    that still fails OPEN. A key in it is never filed at all; if the file
      //    cannot be read the run files anyway, because the cost is one issue a
      //    human closes and that close then suppresses it for good.
      //
      //    No `headBranchPrefix`: this run opens no PRs, so there is no PR
      //    history to date a cooldown from. The issue's own state is the memory.
      const suppression = yield* step("check-suppression", () =>
        checkSuppression({
          keys: unfiled.map((q) => maintenanceKey(q.key)),
          ledgerRepo: controlRepo,
          ledgerPath: declinedPath,
          nowMs: input.firedAt,
        }),
      );
      const allowed = new Set(suppression.allowed);
      const fresh = unfiled.filter((q) => allowed.has(maintenanceKey(q.key)));

      // 8. Nothing fresh is the STEADY STATE, not a failure — every question
      //    the sweep raised is one somebody has already been asked. It is also
      //    the tick that used to open a duplicate PR, so the log line says which
      //    of the two reasons produced the silence.
      if (fresh.length === 0) {
        yield* io.log(
          "info",
          `org-spec-audit: ${merged.length} question(s), ${alreadyFiled.length} already on file, ` +
            `${suppression.suppressed.length} declined — nothing to file`,
        );
        return {
          reposSwept: swept,
          reposSkipped: skipped,
          questionsRaised: raised.length,
          questionsAfterMerge: merged.length,
          questionsAlreadyFiled: alreadyFiled.length,
          questionsSuppressed: suppression.suppressed.length,
          questionsFiled: 0,
          questionsHeldByCap: 0,
        };
      }

      // 9. File. One issue per question, capped, sequentially — this is a write
      //    of at most `maxNew`, and a stable order makes the notice's issue
      //    numbers read in the same order as its lines.
      const toFile = fresh.slice(0, maxNew);
      const heldByCap = fresh.length - toFile.length;

      const opened = yield* Effect.forEach(
        toFile,
        (q) =>
          step(`file-${q.key}`, () =>
            github.openIssue({
              repo: controlRepo,
              title: issueTitle(q),
              body: renderIssueBody({ question: q, day, declinedPath }),
              labels: [questionsLabel, `${lanePrefix}${q.group}`],
            }),
          ).pipe(Effect.map((created) => ({ question: q, ...created }))),
        { concurrency: 1 },
      );

      // 10. Say what CHANGED. Not the standing list — a reader who has already
      //     seen eleven questions is not helped by being shown eleven questions,
      //     and a message whose length tracks the sweep rather than the news is
      //     one people stop opening.
      const openOnFile = onFile.filter((i) => i.state === "open").length + opened.length;
      const notice_ = renderNotice({
        day,
        opened,
        openOnFile,
        heldByCap,
        alreadyFiled: alreadyFiled.length,
        outcomes,
        raised: raised.length,
        suppression,
      });

      yield* step("publish-notice", () =>
        notice.publish({
          useCase: NOTICE_USE_CASE,
          dedupeKey: day,
          text: notice_,
          links: opened.map((o) => ({ url: o.url, label: `#${o.number}` })),
        }),
      );

      yield* io.log(
        "info",
        `org-spec-audit: filed ${opened.length} question(s) (${opened.map((o) => `#${o.number}`).join(", ")}) ` +
          `from ${raised.length} raised — ${alreadyFiled.length} already on file, ` +
          `${suppression.suppressed.length} declined, ${heldByCap} held by the cap`,
      );

      return {
        reposSwept: swept,
        reposSkipped: skipped,
        questionsRaised: raised.length,
        questionsAfterMerge: merged.length,
        questionsAlreadyFiled: alreadyFiled.length,
        questionsSuppressed: suppression.suppressed.length,
        questionsFiled: opened.length,
        questionsHeldByCap: heldByCap,
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
const oneLine = (raw: string): string => raw.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();

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

/** GitHub's own limit. A longer name is rejected at the API, not truncated here. */
const LABEL_MAX_CHARS = 50;

/**
 * A label from config. Unset takes the default; **set-and-unusable is
 * `undefined`**, which the caller turns into a failed run.
 *
 * Falling back on a bad value would be the worse of the two behaviours, and not
 * by a little: this label is BOTH the filter the dedup read applies and the
 * label the write applies. A comma makes those two different things — GitHub's
 * list query joins labels on commas, so the read would filter on two labels
 * while the write applied one — and the symptom is every question re-filing
 * forever with nothing anywhere erroring. Same reasoning as the base ref.
 */
export const parseLabel = (
  raw: string | undefined | null,
  fallback: string,
): string | undefined => {
  if (raw === undefined || raw === null || raw.trim() === "") return fallback;
  const v = raw.trim();
  if (v.includes(",") || v.length > LABEL_MAX_CHARS) return undefined;
  return v;
};

/** A positive-integer config value, falling back when unset or unparseable. */
export const parsePositiveInt = (raw: string | undefined | null, fallback: number): number => {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * The FIRST `maintenance-key` line in an issue body, or `undefined`.
 *
 * First, not last, and not all of them: an issue body carries model prose
 * derived from a swept repo, so a spec can contain a line that looks exactly
 * like a trailer. `renderIssueBody` emits the authentic key as the body's first
 * line for precisely this reason, so first-match is what makes a spoofed key
 * inert rather than authoritative.
 */
export const firstMaintenanceKey = (body: string): string | undefined => {
  for (const line of body.split("\n")) {
    const m = /^maintenance-key:\s*(\S+)\s*$/.exec(line.trim());
    if (m?.[1] !== undefined) return m[1];
  }
  return undefined;
};

/**
 * Index the questions already on file, by `maintenance-key`.
 *
 * Keys outside this run's namespace are ignored, so another consumer sharing the
 * questions label cannot make this run believe it has already asked something.
 * An issue with no key at all is ignored too — a human-opened issue that happens
 * to carry the label is a question this run did not ask and cannot match.
 *
 * On a duplicate key the first wins, which is the most recently updated (GitHub
 * lists `sort=updated&direction=desc`). Which one wins does not matter to the
 * caller — presence is the whole answer — but it should be deterministic.
 */
export const indexFiledQuestions = (issues: readonly IssueRef[]): Map<string, IssueRef> => {
  const byKey = new Map<string, IssueRef>();
  for (const issue of issues) {
    const key = firstMaintenanceKey(issue.body);
    if (key === undefined || !key.startsWith(`${MAINTENANCE_SOURCE}/`)) continue;
    if (!byKey.has(key)) byKey.set(key, issue);
  }
  return byKey;
};

/** Strip the `org-spec-audit/` namespace — the reconcile prompt speaks bare keys. */
const bareKey = (namespaced: string): string => namespaced.slice(MAINTENANCE_SOURCE.length + 1);

type ReconcileArgs = {
  /** Today's questions with no exact key match — the only ones worth asking about. */
  readonly residue: readonly MergedQuestion[];
  readonly onFile: readonly IssueRef[];
  readonly resolved: { backend: string; model: string; mode: "tools" | "json" };
};

/** One accepted match, as a plain row — see `reconcileKeys` on why not a Map. */
type KeyMatch = { readonly minted: string; readonly existing: string };

/**
 * Match today's un-filed questions against the ones already on file, returning
 * one row per question that duplicates one.
 *
 * A plain array rather than a `Map`, because this runs inside `step()` and a
 * step's result is checkpointed as JSON — a `Map` serializes to `{}`, which
 * would silently mean "nothing matched" on a replay. The caller indexes it.
 *
 * **Every answer is checked against the set actually read from the control
 * repo.** A model fully talked into "this duplicates `org-spec-audit/whatever`"
 * produces no match, because `whatever` was never in the list — the same
 * containment `closeIssueAsDuplicate`'s `knownNumbers` uses. The failure
 * direction is deliberate: an unmatched duplicate costs a human one click, and
 * an accepted hallucination is a question that is never asked again.
 */
const reconcileKeys = (args: ReconcileArgs) =>
  Effect.gen(function* () {
    const known = new Map<string, string>();
    for (const issue of args.onFile) {
      const key = firstMaintenanceKey(issue.body);
      if (key !== undefined) known.set(bareKey(key), key);
    }
    const minted = new Set(args.residue.map((q) => q.key));

    const result = yield* completeStructured({
      backend: args.resolved.backend,
      model: args.resolved.model,
      mode: args.resolved.mode,
      system: RECONCILE_PROMPT,
      userBody: renderReconcileBody({ residue: args.residue, onFile: args.onFile }),
      jsonContract: RECONCILE_JSON_CONTRACT,
      schema: KeyReconciliation,
      toolName: "report_key_matches",
      toolDescription: 'For each newly-raised key, the on-file key it duplicates, or "".',
      surface: "org-spec-audit",
      maxTokens: RECONCILE_MAX_TOKENS,
    });

    const matches: KeyMatch[] = [];
    const seen = new Set<string>();
    for (const m of result.matches) {
      const from = m.minted.trim();
      const onto = m.existing.trim();
      // A row about a key we did not ask about, or an on-file key that does not
      // exist, decides nothing. Both are dropped silently rather than logged per
      // row: a model listing a stale key is ordinary, and the interesting event
      // (a question NOT filed because it matched) is logged by the caller.
      if (onto === "" || !minted.has(from) || seen.has(from)) continue;
      const resolvedKey = known.get(onto) ?? known.get(bareKey(onto));
      if (resolvedKey === undefined) continue;
      seen.add(from);
      matches.push({ minted: from, existing: resolvedKey });
    }
    return matches;
  });

/** The reconcile call's data half: what is on file, and what was just raised. */
const renderReconcileBody = (args: {
  readonly residue: readonly MergedQuestion[];
  readonly onFile: readonly IssueRef[];
}): string => {
  const filed = args.onFile.flatMap((issue) => {
    const key = firstMaintenanceKey(issue.body);
    if (key === undefined) return [];
    return [
      `- key: ${bareKey(key)}\n  question: ${oneLine(issue.title)}\n  status: ${issue.state}`,
    ];
  });

  return [
    "## Questions already on file",
    filed.length > 0 ? filed.join("\n") : "(none)",
    "",
    "## Questions raised just now",
    args.residue.map((q) => `- key: ${q.key}\n  question: ${q.question}`).join("\n"),
  ].join("\n");
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

/** GitHub truncates a longer title in its own UI; cut it where we can see it. */
const MAX_TITLE_CHARS = 240;

/** The issue title — the question as asked, which is what a reader scans. */
export const issueTitle = (q: MergedQuestion): string =>
  q.question.length > MAX_TITLE_CHARS ? `${q.question.slice(0, MAX_TITLE_CHARS - 1)}…` : q.question;

/**
 * One question's issue body.
 *
 * **The trailer block comes first, and that order is load-bearing.** Everything
 * below it is model output derived from the contents of a swept repo, so a spec
 * crafted to make the model emit `maintenance-key: org-spec-audit/something`
 * would — with the trailer last — put a spoofed key ahead of the real one for
 * any reader that takes the first match. `indexFiledQuestions` takes exactly
 * that first match, so emitting the authentic key first makes anything the model
 * echoes inert text further down.
 */
export const renderIssueBody = (args: {
  readonly question: MergedQuestion;
  readonly day: string;
  readonly declinedPath: string;
}): string => {
  const q = args.question;
  return (
    [
      `maintenance-key: ${maintenanceKey(q.key)}`,
      MARKER,
      "",
      `> 🤖 Filed by \`flare-dispatch/org-spec-audit\` on ${args.day} — a divergence where` +
        ` *which side is right* is a judgment nobody has made yet, not drift (\`spec-drift-pr\`` +
        ` proposes those).`,
      "",
      `> **Answer in the thread and close this.** Closing is the record: a later sweep that` +
        ` finds this question still unsettled will not re-file it and will never reopen it.` +
        ` To keep it from ever being asked again, add its key to \`${args.declinedPath}\`.`,
      "",
      `**If nobody answers:** ${q.assumption}`,
      "",
      q.evidence,
      "",
      `Raised by: ${q.sources.map((s) => `\`${s.repo}\` (${s.specPath})`).join(" · ")}`,
    ].join("\n") + "\n"
  );
};

/** One filed issue, as the notice reports it. */
type OpenedQuestion = {
  readonly question: MergedQuestion;
  readonly number: number;
  readonly url: string;
};

type NoticeArgs = {
  readonly day: string;
  /** Filed this tick — the news, and the only questions the notice lists. */
  readonly opened: readonly OpenedQuestion[];
  /** Open questions carrying the label after this tick, filed ones included. */
  readonly openOnFile: number;
  readonly heldByCap: number;
  readonly alreadyFiled: number;
  readonly outcomes: readonly RepoOutcome[];
  readonly raised: number;
  readonly suppression: SuppressionReport;
};

/**
 * The announcement — the DELTA, not the standing list.
 *
 * The old rendering was the day's whole file, so its length tracked the sweep
 * rather than the news and a reader who had already seen eleven questions was
 * shown eleven questions again. This lists what was filed, counts what stands,
 * and says what the cap held.
 *
 * Written as GitHub markdown, not Slack mrkdwn: the receiver holds the token and
 * converts at send time, which is where escaping already lives.
 */
export const renderNotice = (args: NoticeArgs): string => {
  const swept = args.outcomes.filter((o) => !o.skipped).map((o) => o.repo);
  const failed = args.outcomes.filter((o) => o.failure !== undefined);
  const quiet = args.outcomes
    .filter((o) => o.skipped && o.failure === undefined)
    .map((o) => o.repo);

  const lines: string[] = [
    `# Spec audit — ${args.day}`,
    "",
    `${args.opened.length} new question(s) · ${args.openOnFile} open · ` +
      // The swept / unchanged / failed split stays in the headline: a failure
      // counted as "unchanged" turns an outage into a quiet week, which is the
      // sentence a reader is least likely to question.
      `${swept.length} repo(s) swept · ${quiet.length} unchanged or without specs · ` +
      `${failed.length} failed · ${args.raised} raised, ${args.alreadyFiled} already on file` +
      (args.suppression.suppressed.length > 0
        ? ` · ${args.suppression.suppressed.length} declined`
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
    const inGroup = args.opened.filter((o) => o.question.group === group);
    if (inGroup.length === 0) continue;

    lines.push(`## ${GROUP_HEADING[group]} (${inGroup.length})`, "");
    for (const o of inGroup) {
      lines.push(
        `- **${o.question.question}** (#${o.number})`,
        `  - raised by: ${o.question.sources.map((s) => `\`${s.repo}\` (${s.specPath})`).join(" · ")}`,
        `  - if nobody answers: ${o.question.assumption}`,
      );
    }
    lines.push("");
  }

  lines.push(
    "---",
    "",
    `Swept: ${swept.length > 0 ? swept.map((r) => `\`${r}\``).join(" · ") : "none"}`,
    `Unchanged or no \`specs/\`: ${quiet.length > 0 ? quiet.map((r) => `\`${r}\``).join(" · ") : "none"}`,
    `Failed: ${failed.length > 0 ? failed.map((o) => `\`${o.repo}\` (${o.failure})`).join(" · ") : "none"}`,
    // Named, never silent: a list the cap shortened reads as fewer problems.
    args.heldByCap > 0
      ? `Held by the per-sweep cap: ${args.heldByCap} — they file on the next sweep.`
      : "Nothing held by the cap.",
  );

  return `${lines.join("\n")}\n`;
};

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
