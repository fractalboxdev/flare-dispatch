// `self-heal-pr`: from an `incident/v1` pack of class `ci` with a command repro, the edit loop in the job sandbox, then
// the repro re-run in that same sandbox, and a draft pull request only on a green repro (specs/runs/agentic.md §
// `self-heal-pr`, FD-AGT-063 to FD-AGT-067).
import type { RunResult } from "@fractalboxdev/mameko-run";
import { Effect, Schema } from "effect";
import { EditLoop, editLoopUnavailable, Shell, StagedWrites } from "./services.ts";

/** The `incident/v1` caps on a text field and a path (FD-IFC-042). */
const TEXT_MAX = 2000;
const PATH_MAX = 400;

const Text = Schema.String.check(Schema.isMaxLength(TEXT_MAX));

/**
 * The `incident/v1` pack `self-heal-pr` accepts: class `ci` with a `command` repro that names its command. A pack of
 * another class, or one whose repro is `derived`, `none` or absent, does not decode, so intake answers its dispatch
 * `400 invalid_inputs` (FD-AGT-063).
 */
export const SelfHealIncident = Schema.Struct({
  contractVersion: Schema.Literal("v1"),
  incidentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  class: Schema.Literal("ci"),
  repo: Schema.String.check(Schema.isMaxLength(200)),
  suspectRef: Schema.optionalKey(
    Schema.Struct({
      base: Schema.String.check(Schema.isMaxLength(PATH_MAX)),
      head: Schema.String.check(Schema.isMaxLength(PATH_MAX)),
      confidence: Schema.optionalKey(Schema.Number),
      advisory: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  diagnosis: Schema.optionalKey(
    Schema.Struct({ title: Text, area: Text, diagnosis: Text, suggestedFix: Text }),
  ),
  ciFailures: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        kind: Schema.Literals(["actions", "pages", "run-step"]),
        name: Text,
        conclusion: Schema.String.check(Schema.isMaxLength(200)),
        command: Schema.optionalKey(Text),
        logTail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4000))),
      }),
    ).check(Schema.isMaxLength(20)),
  ),
  suspectFiles: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(PATH_MAX))).check(Schema.isMaxLength(50)),
  ),
  repro: Schema.Struct({
    kind: Schema.Literal("command"),
    /** A command with a non-blank character: `sh -c` over a blank command exits 0 and would verify any edit. */
    command: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(TEXT_MAX)),
    note: Schema.optionalKey(Text),
  }),
});
export type SelfHealIncident = typeof SelfHealIncident.Type;

/** The repro's timeout when the input names none (FD-AGT-064). */
export const REPRO_TIMEOUT_SEC = 600;

export const SelfHealPrInput = Schema.Struct({
  incident: SelfHealIncident,
  /** The branch the pull request targets; `main` when absent. */
  baseBranch: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  /** The repro's timeout in seconds, at most the run's ceiling; 600 when absent. */
  reproTimeoutSec: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 3600 })),
  ),
});
export type SelfHealPrInput = typeof SelfHealPrInput.Type;

/** The labels of the pull request a verified fix opens (FD-AGT-065). */
export const SELF_HEAL_LABELS = ["self-heal", "self-heal:verified"] as const;

/** FNV-1a over the UTF-8 bytes of `text`, as 8 hex characters. */
const fnv1a = (text: string) => {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) h = Math.imul(h ^ byte, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
};

/**
 * The staged write's branch: one per incident under `flare-dispatch/self-heal`. The slug of the incident id, cut to 48
 * characters, is readable; the hash of the full id keeps two incidents whose slugs match on distinct branches.
 */
export const selfHealBranch = (incidentId: string) => {
  const slug = incidentId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  const hash = fnv1a(incidentId);
  return slug === ""
    ? `flare-dispatch/self-heal-${hash}`
    : `flare-dispatch/self-heal-${slug}-${hash}`;
};

/** The edit loop's prompt: the incident's diagnosis, failures, suspect files and repro command. */
export const selfHealPrompt = (incident: SelfHealIncident) =>
  [
    "A CI command fails on this checkout. Edit the checkout so that the repro command exits 0; change nothing unrelated.",
    `The repro command is: ${incident.repro.command}`,
    "The incident pack follows.",
    "<incident>",
    JSON.stringify(
      {
        diagnosis: incident.diagnosis,
        ciFailures: incident.ciFailures,
        suspectFiles: incident.suspectFiles,
        repro: incident.repro,
      },
      null,
      2,
    ),
    "</incident>",
  ].join("\n");

const quoted = (text: string) => text.replaceAll("`", "'");

/** The `self-heal-pr` body. */
export const runSelfHealPr = (input: SelfHealPrInput) =>
  Effect.gen(function* () {
    const incident = input.incident;
    const edit = yield* EditLoop;
    const loop = yield* edit.run(selfHealPrompt(incident));
    if (editLoopUnavailable(loop))
      return { _tag: "failure", reason: "infra: edit loop unavailable" } satisfies RunResult;

    // The repro re-runs in the job sandbox the edit loop edited, so it sees exactly the edited checkout (FD-AGT-064).
    const shell = yield* Shell;
    const repro = yield* shell.run(incident.repro.command, {
      timeoutMs: (input.reproTimeoutSec ?? REPRO_TIMEOUT_SEC) * 1000,
    });
    if (repro.exitCode !== 0) return { _tag: "failure", reason: "no-fix" } satisfies RunResult;

    const stage = yield* StagedWrites;
    yield* stage.stage({
      branch: selfHealBranch(incident.incidentId),
      baseBranch: input.baseBranch ?? "main",
      message: "fix: repair the failing CI command",
      pr: {
        title: "Repair the failing CI command",
        body: [
          `The repro command \`${quoted(incident.repro.command)}\` failed in CI and exits 0 on the edited checkout in the job sandbox.`,
          "",
          "Review the change before merging: the pull request's own CI runs agent-authored code.",
        ].join("\n"),
        draft: true,
        labels: [...SELF_HEAL_LABELS],
      },
    });
    return { _tag: "success" } satisfies RunResult;
  }).pipe(
    Effect.catchTags({
      StageFailed: (e) =>
        Effect.succeed({
          _tag: "failure",
          reason: `infra: stage: ${e.detail}`,
        } satisfies RunResult),
    }),
  );
