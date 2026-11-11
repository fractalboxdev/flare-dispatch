// `ci-triage-pr`: the last 24 h of failed executions and their failed job logs, a `transform` classification of each, one
// `judgment` write-up staged as a dated report, or a `pr.close` when nothing failed (specs/runs/agentic.md
// § `ci-triage-pr`).
import type { RunResult } from "@fractalboxdev/mameko-run";
import { Clock, Context, Effect, Schema } from "effect";
import { sanitizeModelText } from "../boundary.ts";
import { checkSuppression, suppressionReadFailed, suppressionKey } from "../suppression/ledger.ts";
import { ReadFailed } from "./spec-drift-pr.ts";
import {
  Checkout,
  ModelClient,
  modelFailureVerdict,
  RecipeIntents,
  StagedWrites,
} from "./services.ts";

export const CI_TRIAGE_BRANCH = "flare-dispatch/ci-triage";
export const CI_TRIAGE_ALLOWLIST = [".flare-dispatch/**"] as const;
export const CI_TRIAGE_WINDOW_MS = 24 * 3_600_000;
const LOG_EXCERPT_CHARS = 6000;

export interface FailedExecution {
  readonly executionId: string;
  readonly run: string;
  readonly reason: string;
  readonly finishedAt: number;
}

/** The executions table and the failed job logs. A failed read fails the run; it is never an empty window. */
export class ExecutionsRead extends Context.Service<
  ExecutionsRead,
  {
    readonly failedSince: (
      repository: string,
      since: number,
    ) => Effect.Effect<readonly FailedExecution[], ReadFailed>;
    readonly failedJobLog: (executionId: string) => Effect.Effect<string, ReadFailed>;
  }
>()("@fractalboxdev/flare-dispatch-agentic/ExecutionsRead") {}

export const CiTriageInput = Schema.Struct({
  repo: Schema.Struct({ owner: Schema.String, name: Schema.String }),
  baseBranch: Schema.String,
});
export type CiTriageInput = typeof CiTriageInput.Type;

export const CLASSES = ["flaky", "infra", "regression", "config", "unknown"] as const;

/** The report's path for a day (FD-AGT-072). */
export const reportPath = (now: number) =>
  `.flare-dispatch/ci-triage-${new Date(now).toISOString().slice(0, 10)}.md`;

const classify = (f: FailedExecution, log: string) =>
  Effect.gen(function* () {
    const model = yield* ModelClient;
    const text = yield* model.complete({
      callSite: "classify",
      tier: "transform",
      maxTokens: 16,
      messages: [
        {
          role: "system",
          content: `Classify one CI failure. Answer with exactly one word of: ${CLASSES.join(", ")}.`,
        },
        {
          role: "user",
          content: `Run ${f.run}, reason ${f.reason}.\nFailed job log excerpt:\n${log.slice(-LOG_EXCERPT_CHARS)}`,
        },
      ],
    });
    const word = text.trim().toLowerCase().split(/\s+/)[0] ?? "";
    return (CLASSES as readonly string[]).includes(word) ? word : "unknown";
  });

/** The `ci-triage-pr` body; a suppressed key reads nothing and opens nothing (FD-AGT-043). */
export const runCiTriage = (input: CiTriageInput) =>
  Effect.gen(function* () {
    const suppressed = yield* checkSuppression(suppressionKey(input.repo, CI_TRIAGE_BRANCH));
    if (suppressed) return { _tag: "success" } satisfies RunResult;
    const now = yield* Clock.currentTimeMillis;
    const executions = yield* ExecutionsRead;
    const intents = yield* RecipeIntents;
    const failed = yield* executions.failedSince(
      `${input.repo.owner}/${input.repo.name}`,
      now - CI_TRIAGE_WINDOW_MS,
    );
    if (failed.length === 0) {
      yield* intents.append("close", "pr.close", {
        repo: input.repo,
        branch: CI_TRIAGE_BRANCH,
        base: input.baseBranch,
      });
      return { _tag: "success" } satisfies RunResult;
    }
    const classified: { f: FailedExecution; cls: string }[] = [];
    for (const f of failed) {
      const log = yield* executions.failedJobLog(f.executionId);
      classified.push({ f, cls: yield* classify(f, log) });
    }
    const model = yield* ModelClient;
    const table = classified
      .map(({ f, cls }) => `- ${f.executionId} ${f.run}: ${cls} (${f.reason})`)
      .join("\n");
    const writeUp = yield* model.complete({
      callSite: "write-up",
      tier: "judgment",
      maxTokens: 4096,
      messages: [
        {
          role: "system",
          content:
            "Write a short markdown triage report of the CI failures below: patterns, likely causes, next steps.",
        },
        { role: "user", content: table },
      ],
    });
    const path = reportPath(now);
    const checkout = yield* Checkout;
    yield* checkout.write(
      path,
      [
        `# CI triage, ${path.slice(-13, -3)}`,
        "",
        "## Failures",
        "",
        table,
        "",
        "## Analysis",
        "",
        sanitizeModelText(writeUp),
        "",
      ].join("\n"),
    );
    const stage = yield* StagedWrites;
    yield* stage.stage({
      branch: CI_TRIAGE_BRANCH,
      baseBranch: input.baseBranch,
      message: `docs(ci): triage ${failed.length} failed executions`,
      pr: {
        title: "CI triage report",
        body: `${failed.length} failed executions in the last 24 h.`,
        draft: true,
        labels: ["ci-triage"],
      },
    });
    return { _tag: "success" } satisfies RunResult;
  }).pipe(
    Effect.catchTags({
      SuppressionReadFailed: suppressionReadFailed,
      ReadFailed: (e) =>
        Effect.succeed({
          _tag: "failure",
          reason: `infra: read ${e.source}: ${e.detail}`,
        } satisfies RunResult),
      ModelCallError: (e) => Effect.succeed(modelFailureVerdict(e) satisfies RunResult),
      StageFailed: (e) =>
        Effect.succeed({
          _tag: "failure",
          reason: `infra: stage: ${e.detail}`,
        } satisfies RunResult),
    }),
  );
