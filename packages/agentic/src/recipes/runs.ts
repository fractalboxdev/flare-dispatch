// The agentic runs with bodies, through mameko's `defineRun`: the runner registers each `layer` on its engine.
import { defineRun, type RunResult } from "@fractalboxdev/mameko-run";
import type { Effect, Schema } from "effect";
import { AGENTIC_CATALOG, agenticClassRanks, type AgenticSpec } from "./catalog.ts";
import { CiTriageInput, runCiTriage } from "./ci-triage-pr.ts";
import { ImprovePrInput, runImprovePr } from "./improve-pr.ts";
import { PrReviewInput, runPrReview } from "./pr-review.ts";
import { ReleaseNotesInput, runReleaseNotes } from "./release-notes.ts";
import { runSelfHealPr, SelfHealPrInput } from "./self-heal-pr.ts";
import { runSpecDrift, SpecDriftInput } from "./spec-drift-pr.ts";
import { runTriageIssues, TriageIssuesInput } from "./triage-issues.ts";
import { runTriagePrs, TriagePrsInput } from "./triage-prs.ts";

const specOf = (name: string): AgenticSpec => {
  const entry = AGENTIC_CATALOG[name];
  if (entry === undefined) throw new Error(`no catalogue entry ${name}`);
  return entry.spec;
};

const asRunSpec = (s: AgenticSpec) => ({
  ...s,
  requires: [...s.requires],
  labels: [...s.labels],
  constraints: [...s.constraints],
  grants: { setup: [...s.grants.setup], agent: [...s.grants.agent] },
  outputPaths: [...s.outputPaths],
  intentKinds: [...s.intentKinds],
  ...(s.schedules === undefined ? {} : { schedules: s.schedules.map((x) => ({ ...x })) }),
});

const catalogue = { classRanks: agenticClassRanks };

/**
 * One agentic run through `defineRun`, with its body beside the definition, so an executor whose services depend on
 * the lease builds them inside each execution around the same body.
 */
const agenticRun = <I extends Schema.Top, R>(
  name: string,
  input: I,
  body: (input: I["Type"]) => Effect.Effect<RunResult, never, R>,
) => ({ ...defineRun({ ...asRunSpec(specOf(name)), input }, body, catalogue), body });

export const prReviewRun = agenticRun("pr-review", PrReviewInput, runPrReview);
export const improvePrRun = agenticRun("improve-pr", ImprovePrInput, runImprovePr);
export const selfHealPrRun = agenticRun("self-heal-pr", SelfHealPrInput, runSelfHealPr);
export const specDriftRun = agenticRun("spec-drift-pr", SpecDriftInput, runSpecDrift);
export const ciTriageRun = agenticRun("ci-triage-pr", CiTriageInput, runCiTriage);

export const triageIssuesRun = agenticRun("triage-issues", TriageIssuesInput, runTriageIssues);

export const triagePrsRun = agenticRun("triage-prs", TriagePrsInput, runTriagePrs);

export const releaseNotesRun = agenticRun("release-notes", ReleaseNotesInput, runReleaseNotes);

/** The eight agentic runs, in catalogue order (FD-AGT-001). */
export const agenticRuns = [
  prReviewRun,
  improvePrRun,
  selfHealPrRun,
  specDriftRun,
  triageIssuesRun,
  triagePrsRun,
  ciTriageRun,
  releaseNotesRun,
] as const;
