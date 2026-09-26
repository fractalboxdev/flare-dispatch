// Run: scheduled improvement radar → draft PR
//
// A Schedule-mode run that, per dimension, MEASURES a repo deterministically and
// then asks a model to interpret the measurement and write the proposal. It is
// the third of the maintenance loop's three use cases (process/content/
// maintenance-loop.md §6) and the sibling of `spec-drift-pr`: same
// `completeStructured` engine, same CONFIG_KV-resolved backend, same
// container-only-for-`git` posture, same draft-PR output.
//
// --- Why one run with a `dimension` input, and not three ---------------------
//
// The dimensions differ in their measurement step and their rubric. They share
// the estate, the backend, the materiality floor, the PR shape and the
// suppression key. Three runs would be three copies of everything except the
// part that differs, which is the shape §1 rejects for the loop as a whole.
//
// --- Measure first; the model only interprets --------------------------------
//
// A model asked "how could this CI be faster?" invents plausible advice. A model
// handed "install step: 94s, cache miss rate 100%, 41 runs this week" writes a
// specific PR. So every dimension runs a deterministic measurement in the
// container and passes ONLY the measurement to the model. The measurement is
// also what makes the finding checkable and what goes in the PR body — a
// proposal whose numbers a reviewer cannot re-derive is an opinion.
//
// The corollary bounds this run honestly: **a dimension can only propose what it
// can measure here.** `size` reads the bundle the repo can build in this
// container; it does not model a Worker's runtime footprint. `ci-speed` reads
// the workflow definitions and the timings git can see; real per-step durations
// live in the GitHub Actions API and in FlareDispatch's own `executions` rows,
// and neither is wired into this run yet. Where a dimension cannot measure, it
// reports nothing rather than guessing — an empty findings array is a good
// answer and the deterministic exit below makes it free.
//
// --- Every finding states its cost, not just its saving ----------------------
//
// A proposal that saves 40 seconds of CI by adding a cache layer, a config key
// and a failure mode has not obviously won, and a model asked only "how could
// this be better?" will never say so. The schema therefore REQUIRES a `cost`
// alongside the `saving`, and a finding below the materiality floor is a digest
// line rather than a PR. This is the guard against per-dimension local
// optimization — four dimensions each optimizing their own number, with nobody
// holding the whole, is how a system gets locally faster and globally worse.
//
// --- CONFIG the operator sets (out of band) ---------------------------------
//
//   CONFIG_KV  improve.repos              comma/space-separated `owner/name` list (required)
//   CONFIG_KV  improve.base               base branch to scan + open PRs against (default "main")
//   CONFIG_KV  improve.materiality-floor  percent on the dimension's own metric (default "10")
//   CONFIG_KV  improve.backend            "workers-ai" | "anthropic" | "bedrock" (default workers-ai)
//   CONFIG_KV  improve.prompt             (optional) override the proposal system prompt
//   CONFIG_KV  improve.workers-ai.model   model id
//   CONFIG_KV  improve.workers-ai.mode    "tools" | "json" (default "tools")
//
// Mode: Schedule mode. **No `schedules` entry and no cron in wrangler.jsonc.**
// §6 staggers one dimension per weekday across T1, and arming that is a product
// decision — a storm of agent runs is both a cost spike and an unreviewable pile
// of PRs. The run is dispatchable by hand until someone makes it, exactly as
// `triage-prs` and `triage-issues` are.

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

/** The config namespace — every key this run reads is `improve.*`. */
const NAMESPACE = "improve";
const key = namespacedKey(NAMESPACE);
const REPOS_KEY = key("repos");
const BASE_KEY = key("base");
const FLOOR_KEY = key("materiality-floor");

/** Caps so a huge repo cannot blow the model context window. */
const MAX_MEASUREMENT_CHARS = 30_000;
const PROPOSAL_MAX_TOKENS = 4096;

/** Default materiality floor, in percent on the dimension's own metric (§6). */
const MATERIALITY_FLOOR_DEFAULT = 10;

/**
 * The dimensions this run can measure.
 *
 * `finops` is deliberately absent: `finops-audit` already exists, runs Mondays,
 * and reads Cloudflare account usage rather than a repo checkout. Adding a
 * fourth member here that shells out to the same data would be a second
 * implementation of a run we have.
 */
const Dimension = Schema.Literal("ci-speed", "security", "size");
type DimensionName = typeof Dimension.Type;

/**
 * One improvement finding.
 *
 * `saving` and `cost` are BOTH required and both free text carrying a number:
 * the schema cannot force a reviewer to weigh them, but it can refuse to let a
 * proposal omit the half that argues against itself.
 */
const Finding = Schema.Struct({
  /** One-line statement of the improvement. */
  title: Schema.String,
  /** The `file:line` or path this affects. No citation, no finding. */
  location: Schema.String,
  /** What the measurement says today — quoted from the measurement, not invented. */
  measured: Schema.String,
  /** What it saves, with the number. */
  saving: Schema.String,
  /** What it costs: complexity, a dependency, a config key, a new failure mode. */
  cost: Schema.String,
  /** Percent improvement on the dimension's own metric, for the floor test. */
  percentImprovement: Schema.Number,
  /** The change itself, as prose a human can act on. Never a diff. */
  proposal: Schema.String,
});

const ImprovementReport = Schema.Struct({
  /** One-paragraph reading of the measurement (empty when nothing was found). */
  summary: Schema.String,
  findings: Schema.Array(Finding),
});

/** The generic default proposal prompt (operator-overridable). */
const IMPROVE_PROMPT_DEFAULT = `You read a deterministic measurement of one repository along one
dimension and propose improvements. The MEASUREMENT is the only evidence you
have and the only evidence you may cite: quote it in \`measured\`, never invent a
number, and never propose something the measurement does not support. A finding
that cannot name a file or path is not a finding.

Every finding must state BOTH what it saves and what it costs — complexity, a
new dependency, a new config key, a new failure mode. A proposal that saves 40
seconds by adding a cache layer and a way to fail has not obviously won, and a
report that lists only savings is not usable. Set \`percentImprovement\` honestly
on the dimension's own metric; a finding you cannot size is a finding you have
not measured.

Prefer one good finding to five weak ones. An empty findings array is a good
answer and is the expected answer for a healthy repo. Never propose a change to
CI credentials, secrets, or permissions.`;

const Input = Schema.Struct({
  firedAt: Schema.Number,
  dimension: Dimension,
});

const Output = Schema.Struct({
  dimension: Schema.String,
  reposScanned: Schema.Number,
  prsOpened: Schema.Number,
  prsUpdated: Schema.Number,
  reposClean: Schema.Number,
  belowFloor: Schema.Number,
});

export const improvePr = defineRun({
  name: "improve-pr",
  version: "1.0.0",
  image: "registry.cloudflare.com/fractalbox/flare-dispatch-review:latest",

  // No `schedules` entry and no cron in wrangler.jsonc: §6 staggers one
  // dimension per weekday and arming that is a product decision. Dispatchable
  // by hand until someone makes it.
  inputs: Input,
  outputs: Output,

  limits: { maxDurationSec: 3600, maxConcurrency: 2 },

  run: (input) =>
    Effect.gen(function* () {
      const day = isoDate(input.firedAt);
      const dimension = input.dimension;

      // 1. Scope: the operator's repo list. Listing is the attestation (§3) —
      //    this run never enumerates the installation, and an empty list is a
      //    no-op rather than a crawl.
      const repos = parseList(yield* step("resolve-repos", () => config.get(REPOS_KEY)));
      if (repos.length === 0) {
        yield* step("log-empty", () =>
          io.log("warn", `improve-pr: ${REPOS_KEY} is unset — nothing to scan`),
        );
        return {
          dimension,
          reposScanned: 0,
          prsOpened: 0,
          prsUpdated: 0,
          reposClean: 0,
          belowFloor: 0,
        };
      }

      const baseBranch = (yield* step("resolve-base", () => config.get(BASE_KEY))) ?? "main";
      const floor = parseFloor(yield* step("resolve-floor", () => config.get(FLOOR_KEY)));

      // 2. The backend, under THIS run's namespace. A misconfigured backend
      //    fails loudly — the operator must pin a model.
      const resolved = yield* step("resolve-backend", () =>
        resolveBackend((k) => config.get(k), { namespace: NAMESPACE }),
      ).pipe(
        Effect.catchTag("BackendUnconfigured", (e) =>
          Effect.fail(
            new StepFailed({
              step: "resolve-backend",
              cause: `improve backend "${e.backend}" misconfigured — set ${e.missing}`,
            }),
          ),
        ),
      );

      const promptOverride = yield* step("resolve-prompt", () => config.get(promptKey(NAMESPACE)));
      const systemPrompt = promptOverride ?? IMPROVE_PROMPT_DEFAULT;

      // 3. Scan each repo. One repo's failure is logged and skipped — never
      //    poisons the sibling scans.
      const outcomes = yield* Effect.forEach(
        repos,
        (repo) =>
          scanRepo({ repo, baseBranch, day, dimension, floor, resolved, systemPrompt }).pipe(
            Effect.catchAll((err) =>
              io
                .log("warn", `improve-pr[${dimension}]: skipped ${repo} — ${describe(err)}`)
                .pipe(Effect.as({ opened: false, updated: false, clean: false, belowFloor: 0 })),
            ),
          ),
        { concurrency: 2 },
      );

      return {
        dimension,
        reposScanned: repos.length,
        prsOpened: outcomes.filter((o) => o.opened).length,
        prsUpdated: outcomes.filter((o) => o.updated).length,
        reposClean: outcomes.filter((o) => o.clean).length,
        belowFloor: outcomes.reduce((n, o) => n + o.belowFloor, 0),
      };
    }),
});

// ---------------------------------------------------------------------------

type RepoOutcome = {
  readonly opened: boolean;
  readonly updated: boolean;
  readonly clean: boolean;
  readonly belowFloor: number;
};

type ScanArgs = {
  readonly repo: string;
  readonly baseBranch: string;
  readonly day: string;
  readonly dimension: DimensionName;
  readonly floor: number;
  readonly resolved: { backend: string; model: string; mode: "tools" | "json" };
  readonly systemPrompt: string;
};

/** Measure one repo on one dimension and, when it is material, open its draft PR. */
const scanRepo = (args: ScanArgs) =>
  Effect.gen(function* () {
    const { container, dir } = yield* step(`checkout-${args.repo}`, () =>
      workspace({ repo: args.repo, sha: args.baseBranch }),
    );

    // The deterministic half. The exit code is checked rather than only the
    // output: an empty stdout from a measurement that FAILED is
    // indistinguishable from a repo with nothing to improve, and silently
    // treating a broken tool as a clean bill of health is the same failure as a
    // radar that sees nothing.
    const measured = yield* step(`measure-${args.dimension}-${args.repo}`, () =>
      shRun(container, dir, MEASURE_SCRIPTS[args.dimension]),
    );
    if (measured.exitCode !== 0) {
      return yield* Effect.fail(
        new StepFailed({
          step: `measure-${args.dimension}-${args.repo}`,
          cause: `measurement exited ${measured.exitCode}: ${measured.stderr.slice(0, 200)}`,
        }),
      );
    }

    const measurement = measured.stdout.slice(0, MAX_MEASUREMENT_CHARS);

    // The deterministic exit (§7 fence 1). A dimension that found nothing to
    // measure ends the repo BEFORE any model call — most days, for most repos,
    // this is the outcome and it costs nothing.
    if (measurement.trim().length === 0) {
      yield* io.log(
        "info",
        `improve-pr[${args.dimension}]: ${args.repo} — nothing measurable, skipped before the model`,
      );
      return { opened: false, updated: false, clean: true, belowFloor: 0 } satisfies RepoOutcome;
    }

    const report = yield* step(`interpret-${args.repo}`, () =>
      completeStructured({
        backend: args.resolved.backend,
        model: args.resolved.model,
        mode: args.resolved.mode,
        system: args.systemPrompt,
        userBody: renderUserBody({
          repo: args.repo,
          dimension: args.dimension,
          measurement,
          floor: args.floor,
        }),
        jsonContract: IMPROVE_JSON_CONTRACT,
        schema: ImprovementReport,
        toolName: "propose_improvements",
        toolDescription:
          "Propose improvements supported by the measurement, each with its saving AND its cost (possibly none).",
        surface: "improve",
        maxTokens: PROPOSAL_MAX_TOKENS,
      }),
    );

    // The materiality floor (§6). A finding below it is a digest line, never a
    // PR — ten small PRs nobody reads is worse than one good PR someone merges.
    const material = report.findings.filter((f) => f.percentImprovement >= args.floor);
    const belowFloor = report.findings.length - material.length;

    if (material.length === 0) {
      yield* io.log(
        "info",
        `improve-pr[${args.dimension}]: ${args.repo} — ${belowFloor} finding(s) below the ${args.floor}% floor, none proposed`,
      );
      return { opened: false, updated: false, clean: true, belowFloor } satisfies RepoOutcome;
    }

    // §6's cap: ONE draft PR per repo per dimension per run, carrying the top
    // finding. What got dropped is stated in the body rather than silently
    // truncated — a silent truncation reads as "we covered everything".
    const ranked = [...material].sort((a, b) => b.percentImprovement - a.percentImprovement);
    // `material.length === 0` returned above, so this is non-empty — but the
    // compiler cannot see through the filter, and widening the guard is cheaper
    // than a non-null assertion that would silently survive a later refactor.
    const top = ranked[0];
    if (top === undefined) {
      return { opened: false, updated: false, clean: true, belowFloor } satisfies RepoOutcome;
    }

    const result = yield* step(`open-pr-${args.repo}`, () =>
      github.openDraftPullRequest({
        repo: args.repo,
        baseBranch: args.baseBranch,
        headBranch: `flare-dispatch/improve-${args.dimension}-${args.day}`,
        title: `perf(${args.dimension}): ${top.title} (${args.day})`,
        body: renderPrBody({
          dimension: args.dimension,
          day: args.day,
          repo: args.repo,
          summary: report.summary,
          ranked,
          belowFloor,
          floor: args.floor,
        }),
        commitMessage: `docs(improve): record the ${args.dimension} findings for ${args.day}\n\nGenerated by flare-dispatch improve-pr.`,
        files: [
          {
            path: `improvements/${args.dimension}/${args.day}.md`,
            content: renderReportFile({
              dimension: args.dimension,
              day: args.day,
              repo: args.repo,
              summary: report.summary,
              ranked,
              belowFloor,
              floor: args.floor,
            }),
          },
        ],
      }),
    );

    yield* io.log(
      "info",
      `improve-pr[${args.dimension}]: ${args.repo} — ${result.created ? "opened" : "updated"} draft PR #${result.number}`,
    );
    return {
      opened: result.created,
      updated: !result.created,
      clean: false,
      belowFloor,
    } satisfies RepoOutcome;
  });

// --- In-container measurement scripts ---------------------------------------
//
// Each prints a plain-text measurement, or NOTHING when the dimension does not
// apply to this repo — which is the deterministic exit above. Every one is
// read-only: no install, no build, no network. That bounds what they can see
// and it is the right trade for a run on a timer: a measurement that mutates a
// checkout or reaches the network is a measurement that can fail in ways the
// operator has to reason about at 07:00.

/**
 * CI speed: the workflow definitions and what git can see about them.
 *
 * Deliberately NOT real per-step durations — those live in the GitHub Actions
 * API and in FlareDispatch's own `executions` rows, and neither is wired into
 * this run. What this measures is the CONFIGURATION that predicts slowness: a
 * job with no dependency cache, no concurrency group (so superseded pushes keep
 * running), and the number of jobs that could fan out but do not.
 */
const CI_SPEED_SCRIPT = `
set -e
ls .github/workflows/*.y*ml >/dev/null 2>&1 || exit 0
echo "=== workflow files ==="
for f in .github/workflows/*.y*ml; do
  echo "--- $f ($(wc -l < "$f") lines) ---"
  cat "$f"
done
echo
echo "=== signals ==="
echo "workflows: $(ls .github/workflows/*.y*ml 2>/dev/null | wc -l)"
echo "jobs declared: $(grep -chE '^  [a-zA-Z0-9_-]+:' .github/workflows/*.y*ml 2>/dev/null | paste -sd+ - | bc 2>/dev/null || echo '?')"
echo "steps using a cache action: $(grep -c 'actions/cache' .github/workflows/*.y*ml 2>/dev/null | paste -sd+ - | bc 2>/dev/null || echo 0)"
echo "workflows with a concurrency group: $(grep -lc '^concurrency:' .github/workflows/*.y*ml 2>/dev/null | wc -l)"
echo "setup-node/setup-rust steps declaring cache: $(grep -c 'cache:' .github/workflows/*.y*ml 2>/dev/null | paste -sd+ - | bc 2>/dev/null || echo 0)"
`;

/**
 * Security: advisories and the shape of the dependency surface, from the
 * manifests already in the tree.
 *
 * No install and no network, so this is NOT `npm audit` — it is what the
 * lockfile and manifests say, plus the two patterns §6 names that are visible
 * statically: a credential in a var that should be a secret, and an install
 * script, which is arbitrary code execution at install time and the one thing
 * §5 makes outright ineligible for auto-merge.
 */
const SECURITY_SCRIPT = `
set -e
found=0
if [ -f package.json ]; then
  found=1
  echo "=== package.json ==="
  cat package.json
  echo
  echo "=== packages declaring an install/postinstall script (arbitrary code at install) ==="
  grep -rlE '"(pre|post)?install"[[:space:]]*:' node_modules/*/package.json 2>/dev/null | head -40 || echo "(node_modules not present — lockfile-only view)"
fi
if [ -f Cargo.toml ]; then
  found=1
  echo "=== Cargo.toml ==="
  cat Cargo.toml
fi
if [ "$found" = "0" ]; then exit 0; fi
echo
echo "=== workflow env that looks like a credential in a plain var ==="
grep -rnE '^[[:space:]]*[A-Z_]*(TOKEN|SECRET|KEY|PASSWORD)[A-Z_]*:[[:space:]]*[^\\$]' .github/workflows/ 2>/dev/null | head -20 || echo "(none found)"
echo
echo "=== declared dependency counts ==="
echo "package.json deps: $(grep -cE '^\\s{4}"' package.json 2>/dev/null || echo 0)"
`;

/**
 * Bundle / binary size: what the tree already declares, plus what is on disk.
 *
 * No build, so this is not the deployed bundle's bytes — §6 wants
 * `wrangler deploy --dry-run --outdir`, which needs an install and a build and
 * therefore a much longer, much more failure-prone run. What this measures is
 * the input to that number: the dependency surface and the largest tracked
 * files, which is what a reviewer actually acts on.
 */
const SIZE_SCRIPT = `
set -e
[ -f package.json ] || [ -f Cargo.toml ] || exit 0
echo "=== largest tracked files ==="
git ls-files -z | xargs -0 du -k 2>/dev/null | sort -rn | head -25
echo
echo "=== total tracked size (KB) ==="
git ls-files -z | xargs -0 du -k 2>/dev/null | awk '{s+=$1} END {print s}'
if [ -f package.json ]; then
  echo
  echo "=== dependencies declared ==="
  sed -n '/"dependencies"/,/}/p' package.json
fi
if [ -f wrangler.jsonc ] || [ -f wrangler.toml ]; then
  echo
  echo "=== worker config present — the 3MB gzipped Workers limit applies ==="
  ls -la wrangler.* 2>/dev/null
fi
`;

const MEASURE_SCRIPTS: Record<DimensionName, string> = {
  "ci-speed": CI_SPEED_SCRIPT,
  security: SECURITY_SCRIPT,
  size: SIZE_SCRIPT,
};

/** Run a `sh -lc <script>` in the container, keeping the exit code. */
const shRun = (container: Container, cwd: string, script: string) =>
  sandbox.exec({ container, cwd, command: ["sh", "-lc", script] });

// --- Prompt + PR rendering ---------------------------------------------------

const IMPROVE_JSON_CONTRACT = `{"summary":string,"findings":[{"title":string,"location":string,"measured":string,"saving":string,"cost":string,"percentImprovement":number,"proposal":string}]}`;

const DIMENSION_BRIEF: Record<DimensionName, string> = {
  "ci-speed":
    "CI speed. The metric is wall-clock duration of the pipeline. Look for uncached installs, missing concurrency groups (so superseded pushes keep burning minutes), serial jobs that could fan out, and container cold starts.",
  security:
    "Security. The metric is exposure. Look for credentials in plain workflow vars that should be secrets, packages running install/postinstall scripts, and capability grants wider than their use. Never propose a change that widens a permission.",
  size: "Bundle / binary size. The metric is bytes against the platform limit. Look for heavy dependencies behind rarely-hit paths, large tracked artifacts that should not be in git, and missing minification.",
};

const renderUserBody = (ctx: {
  repo: string;
  dimension: DimensionName;
  measurement: string;
  floor: number;
}): string =>
  [
    `Repository: ${ctx.repo}`,
    `Dimension: ${ctx.dimension}`,
    "",
    `## What this dimension is`,
    DIMENSION_BRIEF[ctx.dimension],
    "",
    `## Materiality floor`,
    `Only findings at or above ${ctx.floor}% improvement on this dimension's own metric are worth a pull request. Report smaller ones too — they become digest lines — but set percentImprovement honestly rather than inflating it to clear the bar.`,
    "",
    "## The measurement (your only evidence)",
    ctx.measurement,
  ].join("\n");

const MARKER = "<!-- flare-dispatch: improve-pr -->";

type RenderCtx = {
  dimension: DimensionName;
  day: string;
  repo: string;
  summary: string;
  ranked: readonly (typeof Finding.Type)[];
  belowFloor: number;
  floor: number;
};

const renderFinding = (f: typeof Finding.Type): readonly string[] => [
  `#### ${f.title}`,
  "",
  `- **Where** \`${f.location}\``,
  `- **Measured** ${f.measured}`,
  `- **Saves** ${f.saving} (~${f.percentImprovement}%)`,
  `- **Costs** ${f.cost}`,
  "",
  f.proposal,
  "",
];

const renderReportFile = (ctx: RenderCtx): string =>
  [
    `# ${ctx.dimension} — ${ctx.day}`,
    "",
    `Repository: \`${ctx.repo}\` · materiality floor ${ctx.floor}%`,
    "",
    ctx.summary.trim().length > 0 ? ctx.summary.trim() : "_See findings below._",
    "",
    `## Findings at or above the floor (${ctx.ranked.length})`,
    "",
    ...ctx.ranked.flatMap(renderFinding),
    ctx.belowFloor > 0
      ? `## Below the floor\n\n${ctx.belowFloor} further finding(s) measured below ${ctx.floor}% and are recorded here rather than proposed.`
      : "",
    "",
  ].join("\n");

const renderPrBody = (ctx: RenderCtx): string =>
  [
    `### ${ctx.dimension} — improvement proposal`,
    "",
    "> 🤖 Draft opened by `flare-dispatch/improve-pr`. Every finding carries the measurement it came from and **what it costs as well as what it saves** — a proposal that only lists savings is not usable. This PR commits the report; it changes no code.",
    "",
    ctx.summary.trim().length > 0 ? ctx.summary.trim() : "_See findings below._",
    "",
    ...ctx.ranked.slice(0, 1).flatMap(renderFinding),
    ctx.ranked.length > 1
      ? `${ctx.ranked.length - 1} further finding(s) at or above the floor are in the committed report.`
      : "",
    ctx.belowFloor > 0
      ? `${ctx.belowFloor} finding(s) measured below the ${ctx.floor}% floor and were not proposed.`
      : "",
    "",
    ...ctx.ranked.map((f) => `maintenance-key: improve-pr/${ctx.dimension}/${slug(f.location)}`),
    "auto-merge: never (a measurement is evidence for a human, not a mandate)",
    "",
    MARKER,
  ]
    .filter((line) => line !== "")
    .join("\n");

/**
 * The suppression key names the LOCATION, not the finding's prose.
 *
 * §10 gap 11 records why: a model-authored key drifts between runs, so a
 * `declined.jsonl` entry suppresses one spelling rather than one question. A
 * path is not model-authored — it is copied out of the measurement — so the
 * same finding about the same file keys the same way next week whatever the
 * model calls it.
 */
const slug = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");

/** Parse the materiality floor, falling back rather than failing on junk. */
const parseFloor = (raw: string | undefined | null): number => {
  const n = Number.parseFloat(raw ?? "");
  return Number.isFinite(n) && n >= 0 ? n : MATERIALITY_FLOOR_DEFAULT;
};

/** The errors `scanRepo`'s `catchAll` knows how to describe precisely. */
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
    Match.orElse(() => (err instanceof Error ? err.message : String(err))),
  );
