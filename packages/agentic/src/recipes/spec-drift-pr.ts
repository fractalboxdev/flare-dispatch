// `spec-drift-pr`: one structured `judgment` call over the specs, the file tree and the commit log, then a rolling draft
// pull request on `specs/**`, or a `pr.close` when the specs are in sync (specs/runs/agentic.md § `spec-drift-pr`).
import type { RunResult } from "@fractalboxdev/mameko-run";
import { Effect, Exit, Schema } from "effect";
import { sanitizeModelText } from "../boundary.ts";
import {
  checkSuppression,
  SUPPRESSION_READ_FAILED,
  suppressionKey,
} from "../suppression/ledger.ts";
import { inAllowlist } from "../staged-write/gate.ts";
import { extractJson } from "./pr-review.ts";
import {
  Checkout,
  ModelClient,
  modelFailureVerdict,
  RecipeIntents,
  Shell,
  StagedWrites,
} from "./services.ts";

export const SPEC_DRIFT_BRANCH = "flare-dispatch/spec-drift";
export const SPEC_DRIFT_ALLOWLIST = ["specs/**"] as const;
export const SPECS_MAX_CHARS = 40_000;
export const TREE_MAX_CHARS = 12_000;
export const LOG_MAX_ENTRIES = 25;

export const SpecDriftInput = Schema.Struct({
  repo: Schema.Struct({ owner: Schema.String, name: Schema.String }),
  baseBranch: Schema.String,
});
export type SpecDriftInput = typeof SpecDriftInput.Type;

const Answer = Schema.Struct({
  inSync: Schema.Boolean,
  summary: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
const decodeAnswer = Schema.decodeUnknownExit(Answer);

export class ReadFailed extends Schema.TaggedError<ReadFailed>()("ReadFailed", {
  source: Schema.String,
  detail: Schema.String,
}) {}

/** The bounded context: at most 40,000 characters of `specs/`, 12,000 of the tree and 25 log entries (FD-AGT-068). */
export const readContext = Effect.gen(function* () {
  const shell = yield* Shell;
  const checkout = yield* Checkout;
  const tree = yield* shell.run("git ls-files");
  if (tree.exitCode !== 0)
    return yield* new ReadFailed({ source: "tree", detail: tree.stderr.slice(0, 200) });
  const log = yield* shell.run(`git log -n ${LOG_MAX_ENTRIES} --format=%h%x20%s`);
  if (log.exitCode !== 0)
    return yield* new ReadFailed({ source: "log", detail: log.stderr.slice(0, 200) });
  let specs = "";
  for (const path of yield* checkout.list("specs")) {
    if (specs.length >= SPECS_MAX_CHARS) break;
    const text = yield* checkout.read(path);
    if (text !== null) specs += `\n=== ${path}\n${text}`;
  }
  return {
    specs: specs.slice(0, SPECS_MAX_CHARS),
    tree: tree.stdout.slice(0, TREE_MAX_CHARS),
    log: log.stdout
      .split("\n")
      .filter((l) => l !== "")
      .slice(0, LOG_MAX_ENTRIES),
  };
});

const SYSTEM = [
  "You reconcile a repository's specifications with its code.",
  'Answer with one JSON object: {"inSync":boolean,"summary":string,"files":[{"path":string,"content":string}]}.',
  "Each file is a full replacement of a path under specs/. When the specs match the code, answer inSync true and no files.",
].join("\n");

/**
 * The `spec-drift-pr` body for one enrolled repository; a suppressed key reads nothing and opens nothing
 * (FD-AGT-043).
 */
export const runSpecDrift = (input: SpecDriftInput) =>
  Effect.gen(function* () {
    const suppression = yield* checkSuppression(suppressionKey(input.repo, SPEC_DRIFT_BRANCH));
    if (suppression.suppressed) return { _tag: "success" } satisfies RunResult;
    const context = yield* readContext;
    const model = yield* ModelClient;
    const text = yield* model.complete({
      callSite: "reconcile",
      tier: "judgment",
      maxTokens: 8192,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `Specs:\n${context.specs}\n\nFile tree:\n${context.tree}\n\nRecent commits:\n${context.log.join("\n")}`,
        },
      ],
    });
    const answer = decodeAnswer(extractJson(text));
    if (Exit.isFailure(answer))
      return { _tag: "failure", reason: "finding: reconcile answer invalid" } satisfies RunResult;
    const intents = yield* RecipeIntents;
    if (answer.value.inSync || answer.value.files.length === 0) {
      yield* intents.append("close", "pr.close", {
        repo: input.repo,
        branch: SPEC_DRIFT_BRANCH,
        base: input.baseBranch,
      });
      return { _tag: "success" } satisfies RunResult;
    }
    const checkout = yield* Checkout;
    for (const f of answer.value.files)
      if (inAllowlist(f.path, SPEC_DRIFT_ALLOWLIST)) yield* checkout.write(f.path, f.content);
    const stage = yield* StagedWrites;
    yield* stage.stage({
      branch: SPEC_DRIFT_BRANCH,
      baseBranch: input.baseBranch,
      message: "docs(specs): reconcile the specs with the code",
      pr: {
        title: "Reconcile the specs with the code",
        body: sanitizeModelText(answer.value.summary),
        draft: true,
        labels: ["spec-drift"],
      },
    });
    return { _tag: "success" } satisfies RunResult;
  }).pipe(
    Effect.catchTags({
      SuppressionReadFailed: () => Effect.succeed(SUPPRESSION_READ_FAILED satisfies RunResult),
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
