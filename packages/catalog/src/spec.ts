// The run catalogue's declarations. This module imports no process or file API, so the control plane's Worker reads
// the same declarations the runner child executes.
import { buildProfile, type Deployment } from "@fractalboxdev/flare-dispatch-profile";
import type { Capability } from "@fractalboxdev/mameko-run";
import { Match } from "effect";
import {
  CHECK_MAX_DURATION_SEC,
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
  };
  readonly retries: number;
  readonly constraints: readonly string[];
  readonly serialize?: boolean;
  readonly grants: { readonly setup: readonly string[]; readonly agent: readonly string[] };
  readonly outputPaths: readonly string[];
  readonly needsModel: boolean;
  readonly intentKinds: readonly string[];
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

const entries: Readonly<Record<string, CatalogEntry>> = {
  check: {
    spec: checkSpec,
    defaultClass: "required",
    manifestKey: "check",
    executors: ["device", "cloud"],
    containerRateUsdPerHour: null,
    appCapabilities: [],
    hostExecution: true,
  },
  oxlint: {
    spec: oxlintSpec,
    defaultClass: "required",
    manifestKey: "oxlint",
    executors: ["device", "cloud"],
    containerRateUsdPerHour: null,
    appCapabilities: [],
    hostExecution: true,
  },
  "gate-job": {
    spec: gateJobSpec,
    defaultClass: "required",
    manifestKey: null,
    executors: ["device", "cloud"],
    containerRateUsdPerHour: null,
    appCapabilities: [],
    hostExecution: true,
  },
  "offload-test": {
    spec: offloadTestSpec,
    defaultClass: "required",
    manifestKey: "offloadTest",
    executors: ["control"],
    containerRateUsdPerHour: 0,
    appCapabilities: ["GithubRead"],
    hostExecution: false,
  },
  "worker-deploy": {
    spec: workerDeploySpec,
    defaultClass: "release",
    manifestKey: "workerDeploy",
    executors: ["cloud"],
    containerRateUsdPerHour: null,
    appCapabilities: ["GithubRead"],
    hostExecution: false,
  },
  "deploy-smoke": {
    spec: deploySmokeSpec,
    defaultClass: "release",
    manifestKey: "deploySmoke",
    executors: ["control"],
    containerRateUsdPerHour: 0,
    appCapabilities: [],
    hostExecution: false,
  },
  "sandbox-image": {
    spec: sandboxImageSpec,
    defaultClass: "required",
    manifestKey: "sandboxImage",
    executors: ["cloud"],
    containerRateUsdPerHour: null,
    appCapabilities: [],
    hostExecution: false,
  },
};

/** The placement of a `sandbox-image` execution (FD-GATE-080): a publish runs `release`, cloud-pinned, on an executor
 * labelled `container-artifact`; a pull request runs `required` anywhere eligible. */
export const sandboxImagePlacement = (publish: boolean) =>
  publish
    ? { className: "release", constraints: ["cloud-pinned"], labels: ["container-artifact"] }
    : { className: "required", constraints: [], labels: [] };

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
