// The agentic runs with bodies, through mameko's `defineRun`: the runner registers each `layer` on its engine.
import { defineRun } from "@fractalboxdev/mameko-run";
import { AGENTIC_CATALOG, agenticClassRanks, type AgenticSpec } from "./catalog.ts";
import { CiTriageInput, runCiTriage } from "./ci-triage-pr.ts";
import { ImprovePrInput, runImprovePr } from "./improve-pr.ts";
import { PrReviewInput, runPrReview } from "./pr-review.ts";
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

export const prReviewRun = defineRun(
  { ...asRunSpec(specOf("pr-review")), input: PrReviewInput },
  runPrReview,
  catalogue,
);
export const improvePrRun = defineRun(
  { ...asRunSpec(specOf("improve-pr")), input: ImprovePrInput },
  runImprovePr,
  catalogue,
);
export const selfHealPrRun = defineRun(
  { ...asRunSpec(specOf("self-heal-pr")), input: SelfHealPrInput },
  runSelfHealPr,
  catalogue,
);
export const specDriftRun = defineRun(
  { ...asRunSpec(specOf("spec-drift-pr")), input: SpecDriftInput },
  runSpecDrift,
  catalogue,
);
export const ciTriageRun = defineRun(
  { ...asRunSpec(specOf("ci-triage-pr")), input: CiTriageInput },
  runCiTriage,
  catalogue,
);

export const triageIssuesRun = defineRun(
  { ...asRunSpec(specOf("triage-issues")), input: TriageIssuesInput },
  runTriageIssues,
  catalogue,
);

export const triagePrsRun = defineRun(
  { ...asRunSpec(specOf("triage-prs")), input: TriagePrsInput },
  runTriagePrs,
  catalogue,
);

/** The agentic runs whose bodies ship at this phase, in catalogue order. */
export const agenticRuns = [
  prReviewRun,
  improvePrRun,
  selfHealPrRun,
  specDriftRun,
  triageIssuesRun,
  triagePrsRun,
  ciTriageRun,
] as const;
