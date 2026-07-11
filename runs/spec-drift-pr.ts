// Run: scheduled spec/implementation drift → draft PR
//
// A Schedule-mode run that, every day, scans each configured repo for drift
// between its `specs/` and the implementation, and opens a DRAFT pull request
// with the reconciling spec edits. It is the unattended, cron-driven sibling of
// the `spec-drift` skill's `--apply`: the skill is invoked by hand; this run
// fires on a wall-clock cadence and files its proposal as a draft PR a human
// reviews before merge.
//
// --- Reuse: the SAME review infra as ai-code-review --------------------------
//
// The model call goes through `@fractalboxdev/flare-dispatch-review-agent`'s reusable
// `completeStructured` engine — the very `workers-ai` backend machinery
// `pr-review` uses (tools/json + auto-fallback + Schema-validated
// output), resolved from CONFIG_KV. No model API key: the Workers AI binding is
// the auth. The detection runs IN THE WORKER; the ONE container image is used
// only for `git` (checkout + reading specs/tree).
//
// --- CONFIG the operator sets (out of band) ---------------------------------
//
//   CONFIG_KV  spec-drift.repos           comma/space-separated `owner/name` list to scan (required)
//   CONFIG_KV  spec-drift.base            base branch to scan + open PRs against (default "main")
//   CONFIG_KV  spec-drift.backend         "workers-ai" | "anthropic" | "bedrock"  (default workers-ai)
//   CONFIG_KV  spec-drift.prompt          (optional) override the drift-detection system prompt
//   CONFIG_KV  spec-drift.workers-ai.model  model id — bare Workers AI catalog id, or a `deepseek/` reasoner (BYOK via AI Gateway)
//   CONFIG_KV  spec-drift.workers-ai.mode   "tools" | "json"  (default "tools"; pin "json" for reasoning models)
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

/** The config namespace — every key this run reads is `spec-drift.*`. */
const NAMESPACE = "spec-drift";
const key = namespacedKey(NAMESPACE);
const REPOS_KEY = key("repos");
const BASE_KEY = key("base");

/** Caps so a huge repo can't blow the model context window. */
const MAX_SPECS_CHARS = 40_000;
const MAX_TREE_CHARS = 12_000;
const PROPOSAL_MAX_TOKENS = 4096;

/** The model's proposed reconciliation — full new contents per spec file. */
const DriftProposal = Schema.Struct({
  /** One-paragraph summary of the drift found (empty when none). */
  summary: Schema.String,
  /** The spec edits to commit — empty when the specs are already in sync. */
  edits: Schema.Array(
    Schema.Struct({
      /** Repo-relative path under `specs/`. */
      path: Schema.String,
      /** The FULL new file content (not a patch). */
      newContent: Schema.String,
      /** Why this edit reconciles the drift. */
      rationale: Schema.String,
    }),
  ),
});

/** The generic default drift-detection prompt (operator-overridable). */
const DEFAULT_SPEC_DRIFT_PROMPT = `You keep a project's specs/ in sync with its implementation.
The IMPLEMENTATION is the source of truth: when a spec disagrees with the code,
the spec is what's wrong — UNLESS the spec explicitly marks a section as not yet
built (TODO / Planned / 🚧 / unchecked checkbox), which is an intentional plan
to leave alone. You are given each spec file's full content plus the repo's file
tree (and recent commit subjects) as drift signal. Report ONLY spec edits you
are confident reconcile real drift: stale prose contradicted by the tree,
references to files/paths that no longer exist, or verbose transcriptions of
code best replaced by a one-line pointer. Preserve each spec's intent, headings,
and tone. Return the FULL new content for every file you change. If nothing has
drifted, return an empty edits array. Never edit code — only specs.`;

const Input = Schema.Struct({
  firedAt: Schema.Number,
});

const Output = Schema.Struct({
  reposScanned: Schema.Number,
  prsOpened: Schema.Number,
  prsUpdated: Schema.Number,
  reposClean: Schema.Number,
});

export const specDriftPr = defineRun({
  name: "spec-drift-pr",
  version: "1.0.0",
  image: "registry.cloudflare.com/fractalbox/flare-dispatch-review:latest",

  // Schedule mode: 05:00 UTC daily. Must also appear in wrangler.jsonc
  // `triggers.crons`.
  schedules: [
    {
      cron: "0 5 * * *",
      idempotencyKey: ({ firedAt }) => `spec-drift-pr:${isoDate(firedAt)}`,
      inputs: ({ firedAt }) => ({ firedAt }),
    },
  ],

  inputs: Input,
  outputs: Output,

  limits: { maxDurationSec: 3600, maxConcurrency: 4 },

  run: (input) =>
    Effect.gen(function* () {
      const day = isoDate(input.firedAt);

      // 1. Scope: the operator's repo list. No enumeration — an empty list is a
      //    no-op (the run is a backstop, not an installation-wide crawler).
      const repos = parseList(
        yield* step("resolve-repos", () => config.get(REPOS_KEY)),
      );
      if (repos.length === 0) {
        yield* step("log-empty", () =>
          io.log("warn", `spec-drift-pr: ${REPOS_KEY} is unset — nothing to scan`),
        );
        return { reposScanned: 0, prsOpened: 0, prsUpdated: 0, reposClean: 0 };
      }

      const baseBranch =
        (yield* step("resolve-base", () => config.get(BASE_KEY))) ?? "main";

      // 2. Resolve the configurable backend (the ai-code-review machinery,
      //    under THIS run's `spec-drift.*` namespace). A misconfigured backend
      //    fails the run loudly — the operator must pin a model.
      const resolved = yield* step("resolve-backend", () =>
        resolveBackend((key) => config.get(key), { namespace: NAMESPACE }),
      ).pipe(
        Effect.catchTag("BackendUnconfigured", (e) =>
          Effect.fail(
            new StepFailed({
              step: "resolve-backend",
              cause: `spec-drift backend "${e.backend}" misconfigured — set ${e.missing}`,
            }),
          ),
        ),
      );

      const promptOverride = yield* step("resolve-prompt", () =>
        config.get(promptKey(NAMESPACE)),
      );
      const systemPrompt = promptOverride ?? DEFAULT_SPEC_DRIFT_PROMPT;

      // 3. Scan each repo. One repo's failure (model, git, GitHub) is logged and
      //    skipped — never poisons the sibling scans.
      const outcomes = yield* Effect.forEach(
        repos,
        (repo) =>
          scanRepo({ repo, baseBranch, day, resolved, systemPrompt }).pipe(
            Effect.catchAll((err) =>
              io
                .log(
                  "warn",
                  `spec-drift-pr: skipped ${repo} — ${describe(err)}`,
                )
                .pipe(Effect.as({ opened: false, updated: false, clean: false })),
            ),
          ),
        { concurrency: 2 },
      );

      return {
        reposScanned: repos.length,
        prsOpened: outcomes.filter((o) => o.opened).length,
        prsUpdated: outcomes.filter((o) => o.updated).length,
        reposClean: outcomes.filter((o) => o.clean).length,
      };
    }),
});

// ---------------------------------------------------------------------------

type RepoOutcome = {
  readonly opened: boolean;
  readonly updated: boolean;
  readonly clean: boolean;
};

type ScanArgs = {
  readonly repo: string;
  readonly baseBranch: string;
  readonly day: string;
  readonly resolved: { backend: string; model: string; mode: "tools" | "json" };
  readonly systemPrompt: string;
};

/** Scan one repo for drift and, when found, open/update its draft PR. */
const scanRepo = (args: ScanArgs) =>
  Effect.gen(function* () {
    const { container, dir } = yield* step(`checkout-${args.repo}`, () =>
      workspace({ repo: args.repo, sha: args.baseBranch }),
    );

    // Gather the drift inputs with plain `git` (no extra CLI in the image).
    const specsText = yield* step(`gather-specs-${args.repo}`, () =>
      shOut(container, dir, SPECS_SCRIPT).pipe(
        Effect.map((s) => s.slice(0, MAX_SPECS_CHARS)),
      ),
    );
    if (specsText.trim().length === 0) {
      // No specs/ dir → nothing to drift from.
      return { opened: false, updated: false, clean: true } satisfies RepoOutcome;
    }
    const tree = yield* step(`gather-tree-${args.repo}`, () =>
      shOut(container, dir, TREE_SCRIPT).pipe(
        Effect.map((s) => s.slice(0, MAX_TREE_CHARS)),
      ),
    );
    const recentLog = yield* step(`gather-log-${args.repo}`, () =>
      shOut(container, dir, LOG_SCRIPT),
    );

    // The reusable structured-output engine — same backend machinery as pr-review.
    const proposal = yield* step(`detect-${args.repo}`, () =>
      completeStructured({
        backend: args.resolved.backend,
        model: args.resolved.model,
        mode: args.resolved.mode,
        system: args.systemPrompt,
        userBody: renderUserBody({ repo: args.repo, specsText, tree, recentLog }),
        jsonContract: DRIFT_JSON_CONTRACT,
        schema: DriftProposal,
        toolName: "propose_spec_edits",
        toolDescription:
          "Propose the spec-file edits that reconcile drift (possibly none).",
        surface: "spec-drift",
        maxTokens: PROPOSAL_MAX_TOKENS,
      }),
    );

    if (proposal.edits.length === 0) {
      yield* io.log("info", `spec-drift-pr: ${args.repo} — specs in sync`);
      return { opened: false, updated: false, clean: true } satisfies RepoOutcome;
    }

    const result = yield* step(`open-pr-${args.repo}`, () =>
      github.openDraftPullRequest({
        repo: args.repo,
        baseBranch: args.baseBranch,
        headBranch: `flare-dispatch/spec-drift-${args.day}`,
        title: `docs(specs): reconcile spec drift (${args.day})`,
        body: renderPrBody(proposal),
        commitMessage: `docs(specs): reconcile spec/implementation drift\n\nGenerated by flare-dispatch spec-drift-pr.`,
        files: proposal.edits.map((e) => ({
          path: e.path,
          content: e.newContent,
        })),
      }),
    );

    yield* io.log(
      "info",
      `spec-drift-pr: ${args.repo} — ${result.created ? "opened" : "updated"} draft PR #${result.number}`,
    );
    return {
      opened: result.created,
      updated: !result.created,
      clean: false,
    } satisfies RepoOutcome;
  });

// --- In-container gather scripts (plain `git`, no extra CLI) -----------------

/** Concatenate every tracked spec markdown with a path delimiter. */
const SPECS_SCRIPT = `for f in $(git ls-files 'specs/*.md' 'specs/**/*.md' 2>/dev/null); do printf '\\n===FILE %s===\\n' "$f"; cat "$f"; done`;
/** The repo's tracked file tree (drift signal: which paths actually exist). */
const TREE_SCRIPT = `git ls-files | head -800`;
/** Recent commit subjects (drift signal: what changed lately). */
const LOG_SCRIPT = `git log --oneline -n 25`;

/** Run a `sh -lc <script>` in the container and return stdout (best-effort). */
const shOut = (container: Container, cwd: string, script: string) =>
  sandbox
    .exec({ container, cwd, command: ["sh", "-lc", script] })
    .pipe(Effect.map((r) => r.stdout));

// --- Prompt + PR rendering ---------------------------------------------------

/** The compact JSON shape the model must emit (engine appends it in json mode). */
const DRIFT_JSON_CONTRACT = `{"summary":string,"edits":[{"path":string,"newContent":string,"rationale":string}]}`;

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

const MARKER = "<!-- flare-dispatch: spec-drift-pr -->";

const renderPrBody = (
  proposal: typeof DriftProposal.Type,
): string =>
  [
    "### Spec drift — proposed reconciliation",
    "",
    "> 🤖 Draft opened by `flare-dispatch/spec-drift-pr`. The implementation is the source of truth; these edits bring the specs back in line. Review before merging.",
    "",
    proposal.summary.trim().length > 0 ? proposal.summary.trim() : "_See per-file rationale below._",
    "",
    "#### Edits",
    ...proposal.edits.map((e) => `- \`${e.path}\` — ${e.rationale}`),
    "",
    MARKER,
  ].join("\n");

/** The errors `scanRepo`'s `catchAll` knows how to describe precisely. */
type CaughtError =
  | BackendUnconfigured
  | ModelCallFailed
  | StructuredOutputInvalid
  | GitHubApiError;

/** Human-readable one-liner for any caught error (model / git / GitHub). */
const describe = (err: unknown): string =>
  Match.value(err as CaughtError).pipe(
    Match.tag(
      "BackendUnconfigured",
      (e) => `backend "${e.backend}" misconfigured — set ${e.missing}`,
    ),
    Match.tag(
      "ModelCallFailed",
      (e) => `model call failed (${e.reason}): ${e.message}`,
    ),
    Match.tag(
      "StructuredOutputInvalid",
      (e) => `unparseable model output (${e.reason})`,
    ),
    Match.tag("GitHubApiError", (e) => `GitHub API ${e.status} (${e.reason})`),
    // Sandbox/git errors and anything else fall here — every tagged error
    // extends `Error`, so its `message` is a faithful one-liner.
    Match.orElse(() =>
      err instanceof Error ? err.message : JSON.stringify(err),
    ),
  );
