// The run catalogue's declarations. This module imports no process or file API, so the control plane's Worker reads
// the same declarations the runner child executes.
import {
  AGENTIC_CATALOG,
  CiTriageInput,
  ImprovePrInput,
  PrReviewInput,
  ReleaseNotesInput,
  SelfHealPrInput,
  SpecDriftInput,
  TriageIssuesInput,
  TriagePrsInput,
} from "@fractalboxdev/flare-dispatch-agentic";
import { buildProfile, deploymentOf, type Deployment } from "@fractalboxdev/flare-dispatch-profile";
import type { Capability } from "@fractalboxdev/mameko-run";
import { Match, SchemaAST, type Schema } from "effect";
import {
  CHECK_MAX_DURATION_SEC,
  CheckInput,
  DeploySmokeInput,
  GateJobInput,
  OffloadTestInput,
  OxlintInput,
  SandboxImageInput,
  SecurityGateInput,
  SecurityRescanInput,
  WorkerDeployInput,
  DEPLOY_SMOKE_MAX_DURATION_SEC,
  GATE_JOB_MAX_DURATION_SEC,
  OFFLOAD_TEST_MAX_DURATION_SEC,
  OXLINT_MAX_DURATION_SEC,
  SANDBOX_IMAGE_MAX_DURATION_SEC,
  SECURITY_GATE_MAX_DURATION_SEC,
  SECURITY_RESCAN_MAX_DURATION_SEC,
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
  /**
   * The run is a read-only scan run (specs/runs/gate.md § Terms): it takes no command input, declares no model call
   * site and declares only `check.*` intent kinds. The registry validator rejects a declaration that sets it and holds
   * any of them (FD-GATE-113).
   */
  readonly readOnlyScan?: boolean;
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
   * The recipe's default class (specs/runs/gate.md § Recipes). Intake's `resolveClass` starts from `spec.limits.qosClass`
   * instead, which keeps `check` and `oxlint` at `batch` outside a pull request; `spec.limits.qosCeiling` is `required`
   * for both, so a pull request whose base branch requires the check still resolves to `required` (FD-PROF-013).
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
  /**
   * The workflow version of the run's registered body: a lease's run payload names it, and the body dispatches on it
   * (MAMEKO-ENG-071). Each run registers one body, at version 1.
   */
  readonly workflowVersion: number;
  /**
   * The run's job sandbox reaches no host and holds no tenant-scope secret (FD-GATE-110): the run declares no grant in
   * either egress phase, so the egress proxy denies every request, and its lease names no cache namespace and carries
   * no compile-cache endpoint or token.
   */
  readonly sealedSandbox?: boolean;
}

/** What the registry validator reads of one run declaration to hold a read-only scan run to its definition. */
export interface RunDeclaration {
  readonly spec: Pick<RunSpecFields, "needsModel" | "intentKinds" | "readOnlyScan">;
  readonly input: { readonly ast: SchemaAST.AST };
  readonly agentic?: {
    readonly declaration: {
      readonly callSites: readonly { readonly name: string }[];
      readonly intentKinds: readonly string[];
    };
  };
}

/** The run declarations the registry validator checks at deploy, each by run name. */
export type RunRegistry = Readonly<Record<string, RunDeclaration>>;

/** One rejection of a read-only scan declaration, naming the run. */
export interface ReadOnlyScanRejection {
  readonly run: string;
  readonly reason: string;
}

/**
 * The input field names that carry a command a job would run: a shell line, an install or discovery line, an argv,
 * an image's smoke commands.
 */
export const COMMAND_INPUT_FIELDS: ReadonlySet<string> = new Set([
  "command",
  "commands",
  "install",
  "discover",
  "script",
  "argv",
  "smoke",
]);

/** The dotted path of every input field whose name is a command field, at any depth of the input schema. */
export const commandInputsOf = (ast: SchemaAST.AST): readonly string[] => {
  const found: string[] = [];
  const seen = new Set<SchemaAST.AST>();
  const walk = (node: SchemaAST.AST, path: string): void => {
    if (seen.has(node)) return;
    seen.add(node);
    if (SchemaAST.isObjects(node)) {
      for (const p of node.propertySignatures) {
        const name = String(p.name);
        const at = path === "" ? name : `${path}.${name}`;
        if (COMMAND_INPUT_FIELDS.has(name)) found.push(at);
        walk(p.type, at);
      }
      for (const i of node.indexSignatures) walk(i.type, `${path}.*`);
    } else if (SchemaAST.isArrays(node)) {
      for (const e of [...node.elements, ...node.rest]) walk(e, `${path}[]`);
    } else if (SchemaAST.isUnion(node)) {
      for (const t of node.types) walk(t, path);
    } else if (SchemaAST.isSuspend(node)) {
      walk(node.thunk(), path);
    } else if (SchemaAST.isDeclaration(node)) {
      for (const t of node.typeParameters) walk(t, path);
    }
  };
  walk(ast, "");
  return found;
};

/**
 * The registry validator's rule for a read-only scan run (FD-GATE-113): a declaration that sets `readOnlyScan` is
 * rejected for each command input its input schema holds, each model call site it declares (and for `needsModel`
 * where it names none), and each intent kind outside the `check.*` kinds. A declaration that does not set it passes.
 */
export const validateReadOnlyScan = (
  run: string,
  declaration: RunDeclaration,
): readonly ReadOnlyScanRejection[] => {
  if (declaration.spec.readOnlyScan !== true) return [];
  const callSites = declaration.agentic?.declaration.callSites ?? [];
  const kinds = [
    ...new Set([
      ...declaration.spec.intentKinds,
      ...(declaration.agentic?.declaration.intentKinds ?? []),
    ]),
  ];
  return [
    ...commandInputsOf(declaration.input.ast).map((field) => `command input ${field}`),
    ...callSites.map((site) => `model call site ${site.name}`),
    ...(declaration.spec.needsModel && callSites.length === 0 ? ["needsModel"] : []),
    ...kinds.filter((kind) => !kind.startsWith("check.")).map((kind) => `intent kind ${kind}`),
  ].map((reason) => ({ run, reason: `readOnlyScan: ${reason}` }));
};

/** A run is a read-only scan run when its declaration sets `readOnlyScan` and passes its rule (FD-GATE-113). */
export const isReadOnlyScanRun = (run: string, declaration: RunDeclaration): boolean =>
  declaration.spec.readOnlyScan === true && validateReadOnlyScan(run, declaration).length === 0;

/** The runs of a registry that are read-only scan runs (FD-OPS-091). */
export const readOnlyScanRunsOf = (registry: RunRegistry): ReadonlySet<string> =>
  new Set(
    Object.entries(registry)
      .filter(([run, d]) => isReadOnlyScanRun(run, d))
      .map(([run]) => run),
  );

const JOB: readonly Capability[] = ["Workspace", "Exec", "Artifact"];

export const checkSpec = gate("check", {
  requires: JOB,
  limits: { maxDurationSec: CHECK_MAX_DURATION_SEC, qosClass: "batch", qosCeiling: "required" },
});
export const oxlintSpec = gate("oxlint", {
  requires: JOB,
  limits: { maxDurationSec: OXLINT_MAX_DURATION_SEC, qosClass: "batch", qosCeiling: "required" },
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

/** The scan runs' capabilities: a workspace and its subprocesses, and the intent that carries the check summary. */
const SCAN: readonly Capability[] = ["Workspace", "Exec", "Intents"];

/** No grant in either phase: the egress proxy attaches nothing and allows no host (FD-GATE-110). */
const NO_GRANTS = { setup: [], agent: [] } as const;

/** `security-gate`, the required check on a pull request and a merge group (specs/runs/gate.md § Recipes). */
export const securityGateSpec = gate("security-gate", {
  requires: SCAN,
  limits: {
    maxDurationSec: SECURITY_GATE_MAX_DURATION_SEC,
    qosClass: "required",
    qosCeiling: "required",
  },
  grants: NO_GRANTS,
  intentKinds: ["check.summary"],
});

/** `security-rescan`, a dispatched rescan of one commit and the catalogue's read-only scan run (§ Terms). */
export const securityRescanSpec = gate("security-rescan", {
  requires: SCAN,
  limits: {
    maxDurationSec: SECURITY_RESCAN_MAX_DURATION_SEC,
    qosClass: "batch",
    qosCeiling: "batch",
  },
  grants: NO_GRANTS,
  intentKinds: ["check.summary"],
  readOnlyScan: true,
});

/** The scan runs: cloud-only (FD-PROF-066), with no grant and no cache in the lease (FD-GATE-110). */
const scanEntry = (
  spec: RunSpecFields,
  input: Schema.Decoder<unknown>,
  defaultClass: string,
): CatalogEntry => ({
  spec,
  input,
  defaultClass,
  manifestKey: "securityGate",
  executors: ["cloud"],
  containerRateUsdPerHour: null,
  appCapabilities: [],
  hostExecution: false,
  workflowVersion: 1,
  sealedSandbox: true,
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
    workflowVersion: 1,
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
    workflowVersion: 1,
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
    workflowVersion: 1,
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
    workflowVersion: 1,
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
    workflowVersion: 1,
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
    workflowVersion: 1,
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
    workflowVersion: 1,
  },
  "security-gate": scanEntry(securityGateSpec, SecurityGateInput, "required"),
  "security-rescan": scanEntry(securityRescanSpec, SecurityRescanInput, "batch"),
};

/** The input schema of each of the eight agentic recipes (specs/runs/agentic.md § Recipes, FD-AGT-001). */
const AGENTIC_INPUTS: Readonly<Record<string, Schema.Decoder<unknown>>> = {
  "pr-review": PrReviewInput,
  "improve-pr": ImprovePrInput,
  "self-heal-pr": SelfHealPrInput,
  "spec-drift-pr": SpecDriftInput,
  "ci-triage-pr": CiTriageInput,
  "triage-issues": TriageIssuesInput,
  "triage-prs": TriagePrsInput,
  "release-notes": ReleaseNotesInput,
};

/**
 * The agentic recipes, each served by a cloud executor through the model gateway (FD-AGT-001). A declared recipe with
 * no input schema has no run in the registry, so it has no catalogue entry either (FD-RUN-063).
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
              workflowVersion: 1,
              agentic: { declaration: entry.declaration, triggers: entry.triggers },
            } satisfies CatalogEntry,
          ],
        ];
  }),
);

const entries: Readonly<Record<string, CatalogEntry>> = { ...gateEntries, ...agenticEntries };

/** Every run of the catalogue by name, the registry the deploy's registry validator checks (FD-GATE-113). */
export const RUN_CATALOG: Readonly<Record<string, CatalogEntry>> = entries;

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

/** The profile package's reading of a `DEPLOYMENT` value, which the runner entry and the Worker share. */
export { deploymentOf };
