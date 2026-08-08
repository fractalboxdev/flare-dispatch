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
// --- Delivery: GitHub acts, Slack tells --------------------------------------
//
// This run does not post to Slack, and must not be given a way to. Slack bot
// tokens live with the Slack ingress and stay there (see
// `apps/dispatcher/src/slack-notify.ts`) — a cron run holding a workspace-write
// credential is how a token ends up somewhere nobody meant it to be. So the
// run's output is a reviewed file in git whose body IS the message: FractalBOT
// reads it from the org corpus and posts the digest with the token it already
// holds. One direction of trust, no new credential here.
//
// --- CONFIG the operator sets (out of band) ---------------------------------
//
//   CONFIG_KV  org-spec-audit.repos          comma/space-separated `owner/name` estate to sweep (required)
//   CONFIG_KV  org-spec-audit.base           base branch to read (default "main")
//   CONFIG_KV  org-spec-audit.control-repo   where the questions PR lands (default "fractalboxdev/org")
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
  sandbox,
  StepFailed,
  step,
  type Container,
} from "@fractalboxdev/flare-dispatch-core";
import type { GitHubApiError } from "@fractalboxdev/flare-dispatch-core";
import { isoDate, parseList, workspace } from "@fractalboxdev/flare-dispatch-core/primitives";
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
const WINDOW_HOURS_KEY = key("window-hours");

/** Where the grouped questions land when the operator names no control repo. */
const CONTROL_REPO_DEFAULT = "fractalboxdev/org";
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
      const repos = parseList(yield* step("resolve-repos", () => config.get(REPOS_KEY)));
      if (repos.length === 0) {
        yield* step("log-empty", () =>
          io.log("warn", `org-spec-audit: ${REPOS_KEY} is unset — nothing to sweep`),
        );
        return {
          reposSwept: 0,
          reposSkipped: 0,
          questionsRaised: 0,
          questionsAfterMerge: 0,
          prOpened: false,
        };
      }

      const baseBranch = (yield* step("resolve-base", () => config.get(BASE_KEY))) ?? "main";
      const controlRepo =
        (yield* step("resolve-control-repo", () => config.get(CONTROL_REPO_KEY))) ??
        CONTROL_REPO_DEFAULT;
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
            Effect.catchAll((err) =>
              io
                .log("warn", `org-spec-audit: skipped ${repo} — ${describe(err)}`)
                .pipe(Effect.as({ repo, skipped: true, questions: [] } satisfies RepoOutcome)),
            ),
          ),
        { concurrency: 2 },
      );

      const raised = outcomes.flatMap((o) => o.questions);
      const merged = mergeAcrossRepos(raised);
      const swept = outcomes.filter((o) => !o.skipped).length;
      const skipped = outcomes.filter((o) => o.skipped).length;

      // 4. Empty means silent. A digest that fires whether or not there is news
      //    is one people learn to skip.
      if (merged.length === 0) {
        yield* io.log("info", `org-spec-audit: ${swept} repo(s) swept, no open questions`);
        return {
          reposSwept: swept,
          reposSkipped: skipped,
          questionsRaised: raised.length,
          questionsAfterMerge: 0,
          prOpened: false,
        };
      }

      // 5. One control-plane PR against the org repo. The file it carries IS
      //    the message FractalBOT posts — this run holds no Slack credential.
      const message = renderMessage({ day, merged, outcomes, raised: raised.length });
      const result = yield* step("open-questions-pr", () =>
        github.openDraftPullRequest({
          repo: controlRepo,
          baseBranch,
          headBranch: `flare-dispatch/spec-audit-questions-${day}`,
          title: `docs(maintenance): open questions from the spec audit sweep (${day})`,
          body: renderPrBody({ day, merged, outcomes, raised: raised.length, message }),
          commitMessage: `docs(maintenance): spec audit open questions (${day})\n\nGenerated by flare-dispatch org-spec-audit.`,
          files: [
            {
              path: `infra/maintenance-loop/open-questions/${day}.md`,
              content: message,
            },
          ],
        }),
      );

      yield* io.log(
        "info",
        `org-spec-audit: ${merged.length} question(s) from ${raised.length} raised — ${result.created ? "opened" : "updated"} PR #${result.number}`,
      );

      return {
        reposSwept: swept,
        reposSkipped: skipped,
        questionsRaised: raised.length,
        questionsAfterMerge: merged.length,
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
  /** True when the repo was skipped — dormant, no specs, or an error. */
  readonly skipped: boolean;
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

    const specsText = yield* step(`gather-specs-${args.repo}`, () =>
      shOut(container, dir, SPECS_SCRIPT).pipe(Effect.map((s) => s.slice(0, MAX_SPECS_CHARS))),
    );
    if (specsText.trim().length === 0) {
      // No specs/ — nothing to audit. Worth a line, not a question: a product
      // repo with no specs is a finding a human already knows how to read.
      yield* io.log("info", `org-spec-audit: ${args.repo} — no specs/`);
      return { repo: args.repo, skipped: true, questions: [] } satisfies RepoOutcome;
    }

    const tree = yield* step(`gather-tree-${args.repo}`, () =>
      shOut(container, dir, TREE_SCRIPT).pipe(Effect.map((s) => s.slice(0, MAX_TREE_CHARS))),
    );

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
    const source = { repo: q.repo, specPath: q.specPath };

    if (existing === undefined) {
      byKey.set(k, {
        key: k,
        group: q.group,
        question: q.question.trim(),
        assumption: q.assumption.trim(),
        sources: [source],
        evidence: q.evidence.trim(),
      });
      continue;
    }

    // Same repo raising the same key twice is one question, not two.
    if (existing.sources.some((s) => s.repo === source.repo && s.specPath === source.specPath)) {
      continue;
    }
    byKey.set(k, { ...existing, sources: [...existing.sources, source] });
  }

  // Most-shared first: a question three repos ask is worth more of a reader's
  // attention than one only a single repo raised.
  return [...byKey.values()].sort((a, b) => b.sources.length - a.sources.length);
};

/** Lowercase slug; falls back to the question text when the model's key is junk. */
const normalizeKey = (key: string, question: string): string => {
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length >= 3
    ? slug
    : question
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
};

/** `window-hours` as a positive integer, falling back to the default. */
export const parseWindowHours = (raw: string | undefined | null): number => {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : WINDOW_HOURS_DEFAULT;
};

// --- In-container gather scripts (plain `git`, no extra CLI) -----------------

/** Concatenate every tracked spec markdown with a path delimiter. */
const SPECS_SCRIPT = `for f in $(git ls-files 'specs/*.md' 'specs/**/*.md' 2>/dev/null); do printf '\\n===FILE %s===\\n' "$f"; cat "$f"; done`;
/** The repo's tracked file tree — the signal for which paths actually exist. */
const TREE_SCRIPT = `git ls-files | head -800`;
/** Commits in the window. Empty output is the deterministic exit. */
const logScript = (hours: number): string => `git log --oneline --since="${hours} hours ago" -n 40`;

/** Run a `sh -lc <script>` in the container and return the full result. */
const shRun = (container: Container, cwd: string, script: string) =>
  sandbox.exec({ container, cwd, command: ["sh", "-lc", script] });

/** Run a `sh -lc <script>` in the container and return stdout (best-effort). */
const shOut = (container: Container, cwd: string, script: string) =>
  shRun(container, cwd, script).pipe(Effect.map((r) => r.stdout));

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
  readonly merged: readonly MergedQuestion[];
  readonly outcomes: readonly RepoOutcome[];
  readonly raised: number;
};

/**
 * The file the PR carries — and the message FractalBOT posts, verbatim.
 *
 * Written as GitHub markdown, not Slack mrkdwn: the canonical artifact is the
 * reviewed file in git, and the Slack twin is derived at send time by whoever
 * holds the token.
 */
export const renderMessage = (args: RenderArgs): string => {
  const swept = args.outcomes.filter((o) => !o.skipped).map((o) => o.repo);
  const skipped = args.outcomes.filter((o) => o.skipped).map((o) => o.repo);
  const dropped = countDropped(args.merged);

  const lines: string[] = [
    `# Spec audit — ${args.day}`,
    "",
    `${swept.length} repo(s) swept · ${skipped.length} unchanged or without specs · ` +
      `${args.merged.length} question(s) from ${args.raised} raised`,
    "",
  ];

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
    `Unchanged or no \`specs/\`: ${skipped.length > 0 ? skipped.map((r) => `\`${r}\``).join(" · ") : "none"}`,
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
 * The PR body. Carries the loop's three machine-readable lines plus the
 * message itself, so a reviewer decides without opening the diff.
 */
const renderPrBody = (args: RenderArgs & { message: string }): string =>
  [
    "### Spec audit — the questions the sweep could not answer",
    "",
    "> 🤖 Draft opened by `flare-dispatch/org-spec-audit`. These are divergences where *which side is right* is a judgment nobody has made yet — not drift (`spec-drift-pr` proposes those). Answer in the thread or edit the file; merging records the answers.",
    "",
    args.message,
    "",
    `maintenance-key: org-spec-audit/${args.day}`,
    `swept: ${
      args.outcomes
        .filter((o) => !o.skipped)
        .map((o) => o.repo)
        .join(", ") || "none"
    }`,
    "auto-merge: never (specs are a sensitive path)",
    "",
    MARKER,
  ].join("\n");

/** The errors `sweepRepo`'s `catchAll` knows how to describe precisely. */
type CaughtError = BackendUnconfigured | ModelCallFailed | StructuredOutputInvalid | GitHubApiError;

/** Human-readable one-liner for any caught error (model / git / GitHub). */
const describe = (err: unknown): string =>
  Match.value(err as CaughtError).pipe(
    Match.tag(
      "BackendUnconfigured",
      (e) => `backend "${e.backend}" misconfigured — set ${e.missing}`,
    ),
    Match.tag("ModelCallFailed", (e) => `model call failed (${e.reason}): ${e.message}`),
    Match.tag("StructuredOutputInvalid", (e) => `unparseable model output (${e.reason})`),
    Match.tag("GitHubApiError", (e) => `GitHub API ${e.status} (${e.reason})`),
    Match.orElse(() => (err instanceof Error ? err.message : JSON.stringify(err))),
  );
