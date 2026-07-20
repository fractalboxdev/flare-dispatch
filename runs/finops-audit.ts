// Run: scheduled FinOps audit of execution cost → draft PR
//
// A Schedule-mode run that, every week, reads the account's Cloudflare usage —
// Worker invocations + errors by script, and AI-inference requests + cache-hit
// rate by model (the cost drivers of the dispatcher's executions) — asks a model
// to surface FinOps optimizations, and opens ONE draft pull request carrying the
// write-up (`.flare-dispatch/finops-<date>.md`): concrete, prioritized cost
// reductions a human reviews. It does NOT mutate anything (it never changes
// config or scales resources); the value is a single weekly, model-written cost
// review filed where the team will see it.
//
// --- Why this exists ---------------------------------------------------------
//
// The expensive half of a BYOC CI/CD platform is its OWN executions: Worker
// invocations, Container minutes, and Workers-AI Neurons / gateway tokens the
// agentic runs (pr-review, product-demo, …) burn. Those costs drift silently —
// a fan-out storm, a low cache-hit rate, a retry loop — until a bill spikes.
// This run turns that into a weekly, reviewable signal.
//
// --- Reuse: the SAME review infra as ai-code-review / ci-triage --------------
//
// The analysis goes through `@fractalboxdev/flare-dispatch-review-agent`'s reusable
// `completeStructured` engine, resolved from CONFIG_KV under this run's
// `finops.*` namespace. Reading usage uses the `cloudflare.usage` +
// `cloudflare.deployments` read capabilities; opening the PR uses
// `github.openDraftPullRequest`. No container.
//
// --- CONFIG the operator sets (out of band) ---------------------------------
//
//   CONFIG_KV  finops.report-repo     repo to open the audit PR on (required)
//   CONFIG_KV  finops.base            base branch (default "main")
//   CONFIG_KV  finops.window-hours    usage window (default 168 = 7 days)
//   CONFIG_KV  finops.projects        (optional) Pages projects to flag failed deploys on
//   CONFIG_KV  finops.backend         "workers-ai" | "anthropic" | "bedrock"  (default workers-ai)
//   CONFIG_KV  finops.prompt          (optional) override the analysis system prompt
//   CONFIG_KV  finops.workers-ai.model  model id — catalog id or `deepseek/` reasoner (+ .workers-ai.mode "tools"|"json", default "tools")
//
// Mode: Schedule mode — the cron MUST also be in wrangler.jsonc `triggers.crons`.

import { Effect, Schema } from "effect";
import {
  type AiModelUsage,
  type CloudflareUsage,
  cloudflare,
  config,
  defineRun,
  type DeploymentRef,
  github,
  io,
  StepFailed,
  step,
  type WorkerUsage,
} from "@fractalboxdev/flare-dispatch-core";
import { isoDate, parseList } from "@fractalboxdev/flare-dispatch-core/primitives";
import {
  completeStructured,
  namespacedKey,
  promptKey,
  resolveBackend,
} from "@fractalboxdev/flare-dispatch-review-agent";

const NAMESPACE = "finops";
const key = namespacedKey(NAMESPACE);
const REPORT_REPO_KEY = key("report-repo");
const BASE_KEY = key("base");
const WINDOW_KEY = key("window-hours");
const PROJECTS_KEY = key("projects");

const WINDOW_HOURS_DEFAULT = 168; // 7 days
const ANALYSIS_MAX_TOKENS = 3072;

/** The model's FinOps findings. */
const FinOpsReport = Schema.Struct({
  /** A 1–2 sentence overview of the period's spend + the headline lever. */
  summary: Schema.String,
  /** One item per distinct optimization, highest-impact first. */
  optimizations: Schema.Array(
    Schema.Struct({
      /** Short title naming the optimization. */
      title: Schema.String,
      /** Cost area — e.g. "workers-ai" | "worker-invocations" | "errors" | "deploys". */
      area: Schema.String,
      /** The cost observation, with the numbers that motivate it. */
      finding: Schema.String,
      /** A concrete change to make (config/run/model/cache/…). */
      recommendation: Schema.String,
      /** Estimated impact — qualitative or quantitative savings. */
      estimatedImpact: Schema.String,
    }),
  ),
});

const PROMPT_DEFAULT = `You are a FinOps analyst for a BYOC CI/CD platform that runs its jobs on
Cloudflare: a dispatcher Worker, Containers, and Workers AI (billed in Neurons)
routed through an AI Gateway. You are given the account's usage over a window:
Worker invocations + errors by script, and AI-inference requests + cache hits by
model. Identify concrete cost optimizations for these executions. Look for: a few
models dominating AI requests (cap fan-out / pick a cheaper model / raise the AI
Gateway cache TTL when cache-hit rate is low); high error counts (retry waste);
invocation spikes. For each, give a short title, the cost area, the finding WITH
the numbers, a concrete recommendation, and an estimated impact. Prefer a few
high-leverage items over many shallow ones. Be specific; do NOT invent metrics
that aren't in the data. This is a review for humans, not an automated change.`;

const Input = Schema.Struct({
  firedAt: Schema.Number,
});

const Output = Schema.Struct({
  workerScripts: Schema.Number,
  aiModels: Schema.Number,
  deployFailures: Schema.Number,
  optimizations: Schema.Number,
  prOpened: Schema.Boolean,
  prUpdated: Schema.Boolean,
  prNumber: Schema.Number,
});

export const finopsAudit = defineRun({
  name: "finops-audit",
  version: "1.0.0",
  image: "registry.cloudflare.com/fractalbox/flare-dispatch-review:latest",

  // Schedule mode: 07:00 UTC every Monday. Must also appear in wrangler.jsonc
  // `triggers.crons`.
  schedules: [
    {
      cron: "0 7 * * 1",
      idempotencyKey: ({ firedAt }) => `finops-audit:${isoDate(firedAt)}`,
      inputs: ({ firedAt }) => ({ firedAt }),
    },
  ],

  inputs: Input,
  outputs: Output,

  limits: { maxDurationSec: 1800, maxConcurrency: 1 },

  run: (input) =>
    Effect.gen(function* () {
      const day = isoDate(input.firedAt);
      const empty: typeof Output.Type = {
        workerScripts: 0,
        aiModels: 0,
        deployFailures: 0,
        optimizations: 0,
        prOpened: false,
        prUpdated: false,
        prNumber: 0,
      };

      // 1. Scope from config.
      const reportRepo = yield* step("resolve-report-repo", () =>
        config.get(REPORT_REPO_KEY),
      );
      if (reportRepo === undefined || reportRepo.length === 0) {
        yield* step("log-no-repo", () =>
          io.log(
            "warn",
            `finops-audit: ${REPORT_REPO_KEY} is unset — nowhere to open the audit PR`,
          ),
        );
        return empty;
      }
      const baseBranch =
        (yield* step("resolve-base", () => config.get(BASE_KEY))) ?? "main";
      const windowHours =
        Number.parseInt(
          (yield* step("resolve-window", () => config.get(WINDOW_KEY))) ?? "",
          10,
        ) || WINDOW_HOURS_DEFAULT;
      const projects = parseList(
        yield* step("resolve-projects", () => config.get(PROJECTS_KEY)),
      );

      // 2. Read usage (read capabilities; degrade to empty when uncredentialed).
      const usage = yield* step("read-usage", () =>
        cloudflare.usage({ windowHours }),
      ).pipe(
        Effect.catchTag("CloudflareApiError", (e) =>
          Effect.fail(
            new StepFailed({
              step: "read-usage",
              cause: `cloudflare.usage failed (${e.reason}, status ${e.status}) — the CLOUDFLARE_API_TOKEN likely lacks Account Analytics:Read`,
            }),
          ),
        ),
      );
      const deployFailures =
        projects.length === 0
          ? []
          : yield* step("read-deploys", () =>
              cloudflare.deployments({
                projects,
                status: "failure",
                createdWithinHours: windowHours,
              }),
            ).pipe(Effect.catchTag("CloudflareApiError", () => Effect.succeed([] as DeploymentRef[])));

      if (usage.workers.length === 0 && usage.ai.length === 0) {
        yield* step("log-empty", () =>
          io.log(
            "info",
            "finops-audit: no Worker or AI usage in window — nothing to analyse",
          ),
        );
        return { ...empty, deployFailures: deployFailures.length };
      }

      // 3. Resolve the configurable review backend (the ai-code-review machinery).
      const resolved = yield* step("resolve-backend", () =>
        resolveBackend((k) => config.get(k), { namespace: NAMESPACE }),
      ).pipe(
        Effect.catchTag("BackendUnconfigured", (e) =>
          Effect.fail(
            new StepFailed({
              step: "resolve-backend",
              cause: `finops backend "${e.backend}" misconfigured — set ${e.missing}`,
            }),
          ),
        ),
      );
      const systemPrompt =
        (yield* step("resolve-prompt", () => config.get(promptKey(NAMESPACE)))) ??
        PROMPT_DEFAULT;

      // 4. Analyse via the reusable structured-output engine. A model failure is
      //    a real failure for an audit run (its whole job is the write-up).
      const report = yield* step("analyse", () =>
        completeStructured({
          backend: resolved.backend,
          model: resolved.model,
          mode: resolved.mode,
          system: systemPrompt,
          userBody: renderUserBody(usage, deployFailures),
          jsonContract: FINOPS_JSON_CONTRACT,
          schema: FinOpsReport,
          toolName: "report_finops",
          toolDescription: "Report the FinOps optimizations for the period's usage.",
          surface: "finops",
          maxTokens: ANALYSIS_MAX_TOKENS,
        }),
      ).pipe(
        Effect.catchTags({
          ModelCallFailed: (e) =>
            Effect.fail(
              new StepFailed({ step: "analyse", cause: `model call failed: ${e.message}` }),
            ),
          StructuredOutputInvalid: (e) =>
            Effect.fail(
              new StepFailed({ step: "analyse", cause: `unparseable audit output: ${e.message}` }),
            ),
        }),
      );

      // 5. Open/update the single weekly audit draft PR.
      const result = yield* step("open-pr", () =>
        github.openDraftPullRequest({
          repo: reportRepo,
          baseBranch,
          headBranch: `flare-dispatch/finops-${day}`,
          title: `chore(finops): execution-cost audit ${day}`,
          body: renderPrBody(report, usage, deployFailures.length),
          commitMessage: `chore(finops): execution-cost audit for ${day}\n\nGenerated by flare-dispatch finops-audit.`,
          files: [
            {
              path: `.flare-dispatch/finops-${day}.md`,
              content: renderReportFile(report, usage, deployFailures, day),
            },
          ],
        }),
      );

      yield* io.log(
        "info",
        `finops-audit: ${result.created ? "opened" : "updated"} draft PR #${result.number} on ${reportRepo} (${report.optimizations.length} optimization(s))`,
      );

      return {
        workerScripts: usage.workers.length,
        aiModels: usage.ai.length,
        deployFailures: deployFailures.length,
        optimizations: report.optimizations.length,
        prOpened: result.created,
        prUpdated: !result.created,
        prNumber: result.number,
      };
    }),
});

// --- Prompt + report rendering ----------------------------------------------

/** The compact JSON shape the model must emit (engine appends it in json mode). */
const FINOPS_JSON_CONTRACT = `{"summary":string,"optimizations":[{"title":string,"area":string,"finding":string,"recommendation":string,"estimatedImpact":string}]}`;

/** `cached/requests` as a percentage string, or "n/a" for zero requests. */
const cacheRate = (a: AiModelUsage): string =>
  a.requests === 0 ? "n/a" : `${Math.round((a.cached / a.requests) * 100)}%`;

const usageLines = (usage: CloudflareUsage): string => {
  const w = usage.workers.map(
    (x: WorkerUsage) =>
      `- [worker] ${x.script}: ${x.requests} requests, ${x.errors} errors`,
  );
  const a = usage.ai.map(
    (x) =>
      `- [ai] ${x.provider}/${x.model}: ${x.requests} requests, ${x.cached} cached (${cacheRate(x)} hit)`,
  );
  return [...w, ...a].join("\n");
};

const deployLines = (deploys: readonly DeploymentRef[]): string =>
  deploys
    .map((d) => `- [deploy-failure] ${d.project} · ${d.environment} on ${d.branch}`)
    .join("\n");

/** The domain body of the user message (the engine appends the per-mode framing). */
const renderUserBody = (
  usage: CloudflareUsage,
  deployFailures: readonly DeploymentRef[],
): string =>
  [
    `Cloudflare usage over the last ${usage.windowHours} hours:`,
    "",
    usageLines(usage),
    ...(deployFailures.length > 0
      ? ["", "Failed deployments in the window (wasted build minutes):", "", deployLines(deployFailures)]
      : []),
  ].join("\n");

const MARKER = "<!-- flare-dispatch: finops-audit -->";

const renderPrBody = (
  report: typeof FinOpsReport.Type,
  usage: CloudflareUsage,
  deploys: number,
): string =>
  [
    `### FinOps audit — ${usage.workers.length} script(s), ${usage.ai.length} model(s) over ${usage.windowHours}h${deploys > 0 ? `, ${deploys} failed deploy(s)` : ""}`,
    "",
    "> 🤖 Draft opened by `flare-dispatch/finops-audit`. A model-written review of execution cost — sanity-check the numbers and the recommendations; this is analysis, not an automated change.",
    "",
    report.summary.trim(),
    "",
    "#### Optimizations",
    ...report.optimizations.map(
      (o) => `- **${o.title}** (${o.area}) — ${o.recommendation} _(impact: ${o.estimatedImpact})_`,
    ),
    "",
    "Full audit committed to `.flare-dispatch/finops-*.md`.",
    "",
    MARKER,
  ].join("\n");

const renderReportFile = (
  report: typeof FinOpsReport.Type,
  usage: CloudflareUsage,
  deploys: readonly DeploymentRef[],
  day: string,
): string =>
  [
    `# Execution-cost audit — ${day}`,
    "",
    report.summary.trim(),
    "",
    "## Optimizations",
    ...report.optimizations.flatMap((o) => [
      `### ${o.title}`,
      `- **Area:** ${o.area}`,
      `- **Finding:** ${o.finding}`,
      `- **Recommendation:** ${o.recommendation}`,
      `- **Estimated impact:** ${o.estimatedImpact}`,
      "",
    ]),
    `## Usage (last ${usage.windowHours}h)`,
    usageLines(usage),
    ...(deploys.length > 0 ? ["", "## Failed deployments", deployLines(deploys)] : []),
    "",
  ].join("\n");
