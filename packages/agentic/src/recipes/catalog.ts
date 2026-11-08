// The agentic recipes' catalogue entries: each run spec with its agentic declaration and triggers
// (specs/runs/agentic.md § Recipes, FD-AGT-001). This module imports no process or file API, so the control plane reads
// the same declarations the runner executes.
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import type { Capability } from "@fractalboxdev/mameko-run";
import type { AgenticDeclaration } from "../declaration.ts";
import { PR_REVIEW_MAX_DURATION_SEC } from "./pr-review.ts";

export interface AgenticSpec {
  readonly name: string;
  readonly version: string;
  readonly requires: readonly Capability[];
  readonly labels: readonly string[];
  readonly limits: {
    readonly maxDurationSec: number;
    readonly qosClass: string;
    readonly qosCeiling: string;
    readonly modelAllowanceUsd?: number;
  };
  readonly retries: number;
  readonly constraints: readonly string[];
  readonly grants: { readonly setup: readonly string[]; readonly agent: readonly string[] };
  readonly outputPaths: readonly string[];
  readonly needsModel: boolean;
  readonly intentKinds: readonly string[];
  readonly schedules?: readonly { readonly cron: string }[];
}

export interface AgenticCatalogEntry {
  readonly spec: AgenticSpec;
  readonly declaration: AgenticDeclaration;
  /** The trigger kinds that start the recipe (specs/runs/agentic.md § Recipes). */
  readonly triggers: readonly ("pull_request" | "dispatch" | "cron" | "pull_request_review")[];
}

const MODEL_RUN: readonly Capability[] = [
  "Workspace",
  "Exec",
  "ModelGateway",
  "Intents",
  "Artifact",
];

const spec = (
  name: string,
  qosClass: "interactive" | "batch",
  maxDurationSec: number,
  intentKinds: readonly string[],
  extra: Partial<AgenticSpec> = {},
): AgenticSpec => ({
  name,
  version: "2.0.0",
  requires: MODEL_RUN,
  labels: [],
  limits: { maxDurationSec, qosClass, qosCeiling: qosClass, modelAllowanceUsd: 2 },
  retries: 0,
  constraints: [],
  grants: { setup: [], agent: [] },
  outputPaths: [],
  needsModel: true,
  intentKinds,
  ...extra,
});

const classes = (privateData: boolean, untrustedInput: boolean, outbound: boolean) => ({
  privateData,
  untrustedInput,
  outbound,
});

const writeback = (branch: string, allowlist: readonly string[]) => ({
  branch,
  baseBranch: "main",
  allowlist,
  allowSensitivePaths: false,
  allowWorkflows: false,
});

/** The eight agentic recipes (FD-AGT-001). */
export const AGENTIC_CATALOG: Readonly<Record<string, AgenticCatalogEntry>> = {
  "pr-review": {
    spec: spec("pr-review", "interactive", PR_REVIEW_MAX_DURATION_SEC, [
      "comment",
      "check.annotations",
    ]),
    declaration: {
      callSites: [
        { name: "retrieval", tier: "transform" },
        { name: "pre-pass", tier: "transform" },
        { name: "reviewer", tier: "judgment" },
      ],
      needsModel: true,
      dataClasses: classes(true, true, false),
      intentKinds: ["comment", "check.annotations"],
    },
    triggers: ["pull_request", "dispatch"],
  },
  "improve-pr": {
    spec: spec("improve-pr", "batch", 3600, ["pr.propose"]),
    declaration: {
      callSites: [{ name: "interpret-and-edit", tier: "judgment" }],
      needsModel: true,
      dataClasses: classes(true, false, false),
      intentKinds: ["pr.propose"],
      writeback: writeback("flare-dispatch/improve", ["**"]),
    },
    triggers: ["cron", "dispatch"],
  },
  "self-heal-pr": {
    spec: spec("self-heal-pr", "interactive", 3600, ["pr.propose"]),
    declaration: {
      callSites: [{ name: "edit-loop", tier: "judgment" }],
      needsModel: true,
      dataClasses: classes(true, false, true),
      intentKinds: ["pr.propose"],
      writeback: writeback("flare-dispatch/self-heal", ["**"]),
    },
    triggers: ["dispatch"],
  },
  "spec-drift-pr": {
    spec: spec("spec-drift-pr", "batch", 1800, ["pr.propose", "pr.close"], {
      schedules: [{ cron: "0 5 * * *" }],
    }),
    declaration: {
      callSites: [{ name: "reconcile", tier: "judgment" }],
      needsModel: true,
      dataClasses: classes(true, false, false),
      intentKinds: ["pr.propose", "pr.close"],
      writeback: writeback("flare-dispatch/spec-drift", ["specs/**"]),
    },
    triggers: ["cron"],
  },
  "triage-issues": {
    spec: spec("triage-issues", "batch", 1800, ["label", "comment", "issue"]),
    declaration: {
      callSites: [{ name: "classify", tier: "transform" }],
      needsModel: true,
      dataClasses: classes(true, true, false),
      intentKinds: ["label", "comment", "issue"],
    },
    triggers: ["cron", "dispatch"],
  },
  "triage-prs": {
    spec: spec("triage-prs", "batch", 1800, ["pr.propose"]),
    declaration: {
      callSites: [{ name: "digest", tier: "transform" }],
      needsModel: false,
      dataClasses: classes(true, false, true),
      intentKinds: ["pr.propose"],
      writeback: writeback("flare-dispatch/triage", [".flare-dispatch/triage/**"]),
    },
    triggers: ["cron", "dispatch"],
  },
  "ci-triage-pr": {
    spec: spec("ci-triage-pr", "batch", 1800, ["pr.propose", "pr.close"], {
      schedules: [{ cron: "0 6 * * *" }],
    }),
    declaration: {
      callSites: [
        { name: "classify", tier: "transform" },
        { name: "write-up", tier: "judgment" },
      ],
      needsModel: true,
      dataClasses: classes(true, false, false),
      intentKinds: ["pr.propose", "pr.close"],
      writeback: writeback("flare-dispatch/ci-triage", [".flare-dispatch/**"]),
    },
    triggers: ["cron"],
  },
  "release-notes": {
    spec: spec("release-notes", "batch", 1800, ["pr.propose", "release.draft", "release.publish"], {
      schedules: [{ cron: "0 9 * * 1" }],
    }),
    declaration: {
      callSites: [{ name: "notes", tier: "judgment" }],
      needsModel: true,
      dataClasses: classes(true, false, false),
      intentKinds: ["pr.propose", "release.draft", "release.publish"],
      writeback: writeback("flare-dispatch/release", [
        "CHANGELOG.md",
        ".flare-dispatch/release/**",
      ]),
    },
    triggers: ["cron", "dispatch", "pull_request_review"],
  },
};

/** Each class's rank in the profile, which `defineRun` checks a run's classes against. */
export const agenticClassRanks: Readonly<Record<string, number>> = Object.fromEntries(
  buildProfile("production").classes.map((c) => [c.name, c.rank]),
);

/** The `writeback` view the `pr.propose` applier and the writeback gate read (FD-AGT-016, FD-LOCAL-094). */
export const agenticWriteback = (run: string) => {
  const entry = Object.hasOwn(AGENTIC_CATALOG, run) ? AGENTIC_CATALOG[run] : undefined;
  return entry?.declaration.writeback === undefined
    ? undefined
    : {
        writeback: entry.declaration.writeback,
        declaresModel: entry.declaration.callSites.length > 0,
      };
};
