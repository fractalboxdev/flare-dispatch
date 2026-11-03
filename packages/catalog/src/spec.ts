// The run catalogue's declarations. This module imports no process or file API, so the control plane's Worker reads
// the same declarations the runner child executes.
import {
  AGENTIC_CATALOG,
  CiTriageInput,
  ImprovePrInput,
  PrReviewInput,
  SpecDriftInput,
} from "@fractalboxdev/flare-dispatch-agentic";
import { buildProfile, type Deployment } from "@fractalboxdev/flare-dispatch-profile";
import type { Capability } from "@fractalboxdev/mameko-run";
import { Match, type Schema } from "effect";
import {
  CHECK_MAX_DURATION_SEC,
  CheckInput,
  DeploySmokeInput,
  GateJobInput,
  OffloadTestInput,
  OxlintInput,
  SandboxImageInput,
  WorkerDeployInput,
  DEPLOY_SMOKE_MAX_DURATION_SEC,
  GATE_JOB_MAX_DURATION_SEC,
  OFFLOAD_TEST_MAX_DURATION_SEC,
  OXLINT_MAX_DURATION_SEC,
  SANDBOX_IMAGE_MAX_DURATION_SEC,
  WORKER_DEPLOY_MAX_DURATION_SEC,
} from "./inputs.ts";

export {
  CHECK_MAX_DURATION_SEC,
  CheckInput,
  CheckStep,
  DEFAULT_STEP_TIMEOUT_SEC,
} from "./inputs.ts";

/** Each class's rank in the profile, which `defineRun` checks a run's classes against (FD-RUN-061). */
export const classRanks: Readonly<Record<string, number>> = Object.fromEntries(
  buildProfile("production").classes.map((c) => [c.name, c.rank]),
);

/** The fields `defineRun` decodes (MAMEKO-RUN-001); the input schema joins them in the run registry. */
export interface RunSpecFields {
  readonly name: string;
  readonly version: string;
  readonly requires: readonly Capability[];
  readonly labels: readonly string[];
  readonly limits: {
    readonly maxDurationSec: number;
    readonly qosClass: string;
    readonly qosCeiling: string;
    /** The model allowance of a run that calls the gateway (specs/runs/agentic.md § Model). */
    readonly modelAllowanceUsd?: number;
  };
  readonly retries: number;
  readonly constraints: readonly string[];
  readonly serialize?: boolean;
  readonly grants: { readonly setup: readonly string[]; readonly agent: readonly string[] };
  readonly outputPaths: readonly string[];
  readonly needsModel: boolean;
  readonly intentKinds: readonly string[];
  /** A run's own schedules, beside any a manifest entry names. */
  readonly schedules?: readonly { readonly cron: string }[];
}

/** An agentic recipe's declaration as the catalogue carries it (specs/runs/agentic.md § Declaration and catalog). */
export interface AgenticEntryFields {
  readonly declaration: {
    readonly callSites: readonly { readonly name: string; readonly tier: string }[];
    readonly needsModel: boolean;
    readonly dataClasses: {
      readonly privateData: boolean;
      readonly untrustedInput: boolean;
      readonly outbound: boolean;
    };
    readonly intentKinds: readonly string[];
    readonly writeback?: unknown;
  };
  /** The trigger kinds that start the recipe. */
  readonly triggers: readonly string[];
}

const gate = (
  name: string,
  fields: Partial<RunSpecFields> & Pick<RunSpecFields, "limits" | "requires">,
): RunSpecFields => ({
  name,
  version: "2.0.0",
  labels: [],
  retries: 0,
  constraints: [],
  grants: { setup: [], agent: [] },
  outputPaths: [],
  needsModel: false,
  intentKinds: [],
  ...fields,
});

/** Where an execution of a run may run. `control` is the control pool: no container (MAMEKO-EXEC-043). */
export type ExecutorKind = "device" | "cloud" | "control";

/** What the control plane reads of a run: `defineRun`'s fields and the declarations beside them (FD-RUN-062). */
export interface CatalogEntry {
  readonly spec: RunSpecFields;
  /** The run's input schema, which a dispatch's inputs and a request decoder's answer must pass (FD-IFC-029). */
  readonly input: Schema.Decoder<unknown>;
  /** The repo-manifest key the run reads (specs/runs/gate.md § Recipes). */
  readonly manifestKey: string | null;
  /**
   * The recipe's default class, which `resolveClass` starts from (specs/runs/gate.md § Recipes). `spec.limits.qosClass`
   * stays the class the control plane admits a device run at until intake resolves classes.
   */
  readonly defaultClass: string;
  /** The executor kinds that can serve the run's capabilities. */
  readonly executors: readonly ExecutorKind[];
  /** The container rate the execution's hold carries; 0 for a run that makes no sandbox call (FD-GATE-045). */
  readonly containerRateUsdPerHour: number | null;
  /** The application capabilities the run reads beside mameko's, which stay out of `requires`. */
  readonly appCapabilities: readonly "GithubRead"[];
  /** An agentic recipe's declaration and triggers; absent for a gate run. */
  readonly agentic?: AgenticEntryFields;
  /**
   * The run executes on the device's host OS, outside any job sandbox. MAMEKO-ISO-001 forbids that, and no conformant
   * macOS runtime exists, so such a run stays reachable only under the `development` deployment.
   */
  readonly hostExecution: boolean;
}

const JOB: readonly Capability[] = ["Workspace", "Exec", "Artifact"];

export const checkSpec = gate("check", {
  requires: JOB,
  limits: { maxDurationSec: CHECK_MAX_DURATION_SEC, qosClass: "batch", qosCeiling: "batch" },
});
export const oxlintSpec = gate("oxlint", {
  requires: JOB,
  limits: { maxDurationSec: OXLINT_MAX_DURATION_SEC, qosClass: "batch", qosCeiling: "batch" },
});
export const gateJobSpec = gate("gate-job", {
  requires: [...JOB, "Cache"],
  limits: {
    maxDurationSec: GATE_JOB_MAX_DURATION_SEC,
    qosClass: "batch",
    qosCeiling: "batch",
  },
});
export const offloadTestSpec = gate("offload-test", {
  requires: ["Children", "Intents"],
  limits: {
    maxDurationSec: OFFLOAD_TEST_MAX_DURATION_SEC,
    qosClass: "required",
    qosCeiling: "release",
  },
  intentKinds: ["release.draft", "release.publish"],
});
export const workerDeploySpec = gate("worker-deploy", {
  requires: [...JOB, "Intents"],
  limits: {
    maxDurationSec: WORKER_DEPLOY_MAX_DURATION_SEC,
    qosClass: "release",
    qosCeiling: "release",
  },
  constraints: ["cloud-pinned"],
  serialize: true,
  grants: { setup: ["cf-api"], agent: [] },
  intentKinds: ["dispatch.followOn"],
});
export const deploySmokeSpec = gate("deploy-smoke", {
  requires: ["IO"],
  limits: {
    maxDurationSec: DEPLOY_SMOKE_MAX_DURATION_SEC,
    qosClass: "release",
    qosCeiling: "release",
  },
  constraints: ["control-pool"],
});
export const sandboxImageSpec = gate("sandbox-image", {
  requires: JOB,
  limits: {
    maxDurationSec: SANDBOX_IMAGE_MAX_DURATION_SEC,
    qosClass: "required",
    qosCeiling: "release",
  },
});

const gateEntries: Readonly<Record<string, CatalogEntry>> = {
  check: {
    spec: checkSpec,
    input: CheckInput,
    defaultClass: "required",
    manifestKey: "check",
    executors: ["device", "cloud"],
    containerRateUsdPerHour: null,
    appCapabilities: [],
    hostExecution: true,
  },
  oxlint: {
    spec: oxlintSpec,
    input: OxlintInput,
    defaultClass: "required",
    manifestKey: "oxlint",
    executors: ["device", "cloud"],
    containerRateUsdPerHour: null,
    appCapabilities: [],
    hostExecution: true,
  },
  "gate-job": {
    spec: gateJobSpec,
    input: GateJobInput,
    defaultClass: "required",
    manifestKey: null,
    executors: ["device", "cloud"],
    containerRateUsdPerHour: null,
    appCapabilities: [],
    hostExecution: true,
  },
  "offload-test": {
    spec: offloadTestSpec,
    input: OffloadTestInput,
    defaultClass: "required",
    manifestKey: "offloadTest",
    executors: ["control"],
    containerRateUsdPerHour: 0,
    appCapabilities: ["GithubRead"],
    hostExecution: false,
  },
  "worker-deploy": {
    spec: workerDeploySpec,
    input: WorkerDeployInput,
    defaultClass: "release",
    manifestKey: "workerDeploy",
    executors: ["cloud"],
    containerRateUsdPerHour: null,
    appCapabilities: ["GithubRead"],
    hostExecution: false,
  },
  "deploy-smoke": {
    spec: deploySmokeSpec,
    input: DeploySmokeInput,
    defaultClass: "release",
    manifestKey: "deploySmoke",
    executors: ["control"],
    containerRateUsdPerHour: 0,
    appCapabilities: [],
    hostExecution: false,
  },
  "sandbox-image": {
    spec: sandboxImageSpec,
    input: SandboxImageInput,
    defaultClass: "required",
    manifestKey: "sandboxImage",
    executors: ["cloud"],
    containerRateUsdPerHour: null,
    appCapabilities: [],
    hostExecution: false,
  },
};

/** The input schema of each agentic recipe whose body ships at this phase (specs/runs/agentic.md § Recipes). */
const AGENTIC_INPUTS: Readonly<Record<string, Schema.Decoder<unknown>>> = {
  "pr-review": PrReviewInput,
  "improve-pr": ImprovePrInput,
  "spec-drift-pr": SpecDriftInput,
  "ci-triage-pr": CiTriageInput,
};

/**
 * The agentic recipes with a body, each served by a cloud executor through the model gateway. A recipe whose body is
 * a later phase's has no run in the registry, so it has no catalogue entry either (FD-RUN-063).
 */
const agenticEntries: Readonly<Record<string, CatalogEntry>> = Object.fromEntries(
  Object.entries(AGENTIC_CATALOG).flatMap(([name, entry]) => {
    const input = AGENTIC_INPUTS[name];
    return input === undefined
      ? []
      : [
          [
            name,
            {
              spec: entry.spec,
              input,
              manifestKey: name,
              defaultClass: entry.spec.limits.qosClass,
              executors: ["cloud"],
              containerRateUsdPerHour: null,
              appCapabilities: [],
              hostExecution: false,
              agentic: { declaration: entry.declaration, triggers: entry.triggers },
            } satisfies CatalogEntry,
          ],
        ];
  }),
);

const entries: Readonly<Record<string, CatalogEntry>> = { ...gateEntries, ...agenticEntries };

/** The placement of a `sandbox-image` execution (FD-GATE-080): a publish runs `release`, cloud-pinned, on an executor
 * labelled `container-artifact`; a pull request runs `required` anywhere eligible. */
export const sandboxImagePlacement = (publish: boolean) =>
  publish
    ? { className: "release", constraints: ["cloud-pinned"], labels: ["container-artifact"] }
    : { className: "required", constraints: [], labels: [] };

/**
 * The placement constraints and capability labels one request of a run declares: the run's own, and for a
 * `sandbox-image` request whose input publishes, those of `sandboxImagePlacement(true)` (FD-GATE-061, FD-GATE-080).
 */
export const requestPlacement = (
  spec: Pick<RunSpecFields, "name" | "constraints" | "labels">,
  inputs: unknown,
): { readonly constraints: readonly string[]; readonly labels: readonly string[] } => {
  const publishes =
    spec.name === "sandbox-image" &&
    typeof inputs === "object" &&
    inputs !== null &&
    (inputs as { readonly publish?: unknown }).publish === true;
  const extra = publishes ? sandboxImagePlacement(true) : { constraints: [], labels: [] };
  return {
    constraints: [...new Set([...spec.constraints, ...extra.constraints])],
    labels: [...new Set([...spec.labels, ...extra.labels])],
  };
};

/** Every run's name, in catalogue order. */
export const RUN_NAMES: readonly string[] = Object.keys(entries);

export type RunLookup =
  | { readonly _tag: "Available"; readonly entry: CatalogEntry }
  | { readonly _tag: "HostExecutionRefused" }
  | { readonly _tag: "NotInCatalogue" };

/** Whether a run is dispatchable under a deployment; `production` refuses a host execution. */
export const lookupRun = (deployment: Deployment, run: string): RunLookup => {
  const entry = Object.hasOwn(entries, run) ? entries[run] : undefined;
  if (entry === undefined) return { _tag: "NotInCatalogue" };
  return Match.value(deployment).pipe(
    Match.when("development", (): RunLookup => ({ _tag: "Available", entry })),
    Match.when("production", (): RunLookup =>
      entry.hostExecution ? { _tag: "HostExecutionRefused" } : { _tag: "Available", entry },
    ),
    Match.exhaustive,
  );
};

/** `production` unless the process says `development`, so a device with no configuration refuses host execution. */
export const deploymentOf = (value: string | undefined): Deployment =>
  value === "development" ? "development" : "production";
