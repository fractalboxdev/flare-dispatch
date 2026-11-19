// The run registry, the only list of runs (FD-RUN-063, MAMEKO-RUN-008). It holds Node process code, so only the
// runner entry and its tests import it. Each executor kind supplies the Layers of the services its runs require.
import type { Deployment } from "@fractalboxdev/flare-dispatch-profile";
import {
  agenticRuns,
  type CloudAgenticServices,
} from "@fractalboxdev/flare-dispatch-agentic/executor";
import { type Intents, type LocalContent } from "@fractalboxdev/mameko-run";
import { Layer } from "effect";
import { runCheck } from "./check.ts";
import { processGateExec, type GateExec } from "./command.ts";
import { perExecution, type LeaseLayerContext, type LeaseLayerFailure } from "./execution-lease.ts";
import { githubReadLayer, type GithubRead } from "./github-read.ts";
import {
  CheckInput,
  GateJobInput,
  OxlintInput,
  SandboxImageInput,
  SecurityGateInput,
  SecurityRescanInput,
  WorkerDeployInput,
} from "./inputs.ts";
import { runGateJob } from "./job.ts";
import { runOxlint } from "./oxlint.ts";
import { localContentArtifacts, type GateArtifacts } from "./ports.ts";
import {
  canaryRun,
  deploySmokeRun,
  imagePublishRun,
  offloadTestRun,
  stackDeployRun,
} from "./control-runs.ts";
import { defineGateRun } from "./gate-run.ts";
import { runSandboxImage } from "./sandbox-image.ts";
import { runSecurityGate, runSecurityRescan, type ScanServices } from "./security-gate.ts";
import {
  checkSpec,
  floorCanary,
  gateJobSpec,
  lookupRun,
  oxlintSpec,
  sandboxImageSpec,
  securityGateSpec,
  securityRescanSpec,
  workerDeploySpec,
  type ExecutorKind,
} from "./spec.ts";
import { runWorkerDeploy, type DeployLedger } from "./worker-deploy.ts";

const define = defineGateRun;

export const checkRun = define(checkSpec, CheckInput, runCheck);
export const oxlintRun = define(oxlintSpec, OxlintInput, runOxlint);
export const gateJobRun = define(gateJobSpec, GateJobInput, runGateJob);
export const workerDeployRun = define(workerDeploySpec, WorkerDeployInput, runWorkerDeploy);
export { deploySmokeRun, imagePublishRun, offloadTestRun, stackDeployRun };
export type { LeaseLayerContext };
export const sandboxImageRun = define(sandboxImageSpec, SandboxImageInput, runSandboxImage);
export const securityGateRun = define(securityGateSpec, SecurityGateInput, runSecurityGate);
export const securityRescanRun = define(securityRescanSpec, SecurityRescanInput, runSecurityRescan);

/** Every run, in catalogue order. */
export const registry = [
  checkRun,
  oxlintRun,
  gateJobRun,
  offloadTestRun,
  workerDeployRun,
  deploySmokeRun,
  sandboxImageRun,
  imagePublishRun,
  stackDeployRun,
  securityGateRun,
  securityRescanRun,
  ...agenticRuns,
  floorCanary,
  canaryRun,
] as const;

/** Whether the executor kind serves a run under the deployment, from the deployment's catalogue entry. */
const servedBy = (deployment: Deployment, name: string, kind: ExecutorKind): boolean => {
  const found = lookupRun(deployment, name);
  return found._tag === "Available" && found.entry.executors.includes(kind);
};

/**
 * The device executor's Layers: processes on the host, artifacts on the execution's local content store, and GitHub
 * reads that leave through `fetch` for the egress proxy to credential.
 */
export const deviceLayers: Layer.Layer<GateExec | GateArtifacts | GithubRead, never, LocalContent> =
  Layer.mergeAll(
    processGateExec,
    localContentArtifacts,
    githubReadLayer({ apiBase: "https://api.github.com", fetch: globalThis.fetch }),
  );

/** The services the gate runs a cloud executor serves require: the device's, and the deploy ledger. */
export type CloudGateServices = GateExec | GateArtifacts | GithubRead | DeployLedger;

/** The executor a runner entry serves: the device, or the cloud executor with the Layers of the runs it serves. */
export type RunnerExecutor =
  | { readonly kind: "device" }
  | {
      readonly kind: "cloud";
      /**
       * The agentic recipes' services for the execution's job sandbox, from `cloudAgenticLayers`, built inside each
       * execution from its `ExecutionLease` and the runner's services. A Layer that fails ends the run with
       * `infra: <tag>` before the body starts. Without them the cloud executor serves no agentic recipe.
       */
      readonly layers?: Layer.Layer<CloudAgenticServices, LeaseLayerFailure, LeaseLayerContext>;
      /**
       * The scan runs' services for the execution's job sandbox: its processes, the scan bundle store, the image, the
       * advisory snapshots and the deployment's scan settings, built inside each execution as `layers` is. Without them
       * the cloud executor serves no scan run.
       */
      readonly scan?: Layer.Layer<
        Exclude<ScanServices, Intents>,
        LeaseLayerFailure,
        LeaseLayerContext
      >;
      /**
       * The gate runs' services where the Container is the job sandbox: processes on its host, artifacts on the
       * execution's local content store, GitHub reads and a deploy ledger that outlives a reclaim. Without them the
       * cloud executor serves no gate run.
       */
      readonly gate?: Layer.Layer<CloudGateServices, never, LocalContent>;
    };

const AGENTIC_NAMES: ReadonlySet<string> = new Set(agenticRuns.map((run) => run.spec.name));

/** The scan runs the cloud executor serves with its scan Layers (specs/runs/gate.md § Security gate). */
const SCAN_NAMES: ReadonlySet<string> = new Set([
  securityGateRun.spec.name,
  securityRescanRun.spec.name,
]);

/** The floor canary, which a cloud executor serves on the runner's own services (MAMEKO-OPS-012). */
const FLOOR_CANARY_NAME = floorCanary.spec.name;

/** A registry run whose body is registered beside its definition: every run but mameko's floor canary. */
type BodiedRun = Exclude<(typeof registry)[number], typeof floorCanary>;

const withBody = (run: (typeof registry)[number]): run is BodiedRun => "body" in run;

/**
 * The gate runs a cloud executor serves with its gate Layers: a run whose catalogue entry lists `cloud` and that is
 * neither agentic, a scan run nor the floor canary. A host execution is among them: the Container is its job sandbox,
 * so the cloud executor serves the same gate runs under both deployments.
 */
const isCloudGateRun = (name: string): boolean => {
  const found = lookupRun("development", name);
  return (
    found._tag === "Available" &&
    found.entry.executors.includes("cloud") &&
    !AGENTIC_NAMES.has(name) &&
    !SCAN_NAMES.has(name) &&
    name !== FLOOR_CANARY_NAME
  );
};

/**
 * The runs an executor may execute under a deployment, each with that executor's Layers provided. A run `lookupRun`
 * refuses, that the catalogue does not serve on the executor's kind, or that needs a service the executor lacks is
 * absent, so its lease answers `RunNotInCatalog`. The device serves the gate runs; the cloud executor serves the
 * agentic recipes, whose catalogue entries are cloud-only, where it supplies their Layers; `security-gate` and
 * `security-rescan` where it supplies the scan Layers; the cloud gate runs where it supplies the gate Layers; and the
 * floor canary on the runner's own services.
 */
export const runsFor = (deployment: Deployment, executor: RunnerExecutor = { kind: "device" }) => {
  const available = registry
    .filter((run) => lookupRun(deployment, run.spec.name)._tag === "Available")
    .filter((run) => servedBy(deployment, run.spec.name, executor.kind));
  return executor.kind === "device"
    ? available.map((run) => ({
        ...run,
        layer: (run.layer as Layer.Layer<never, never, GateExec | GateArtifacts | GithubRead>).pipe(
          Layer.provide(deviceLayers),
        ),
      }))
    : [
        ...gateRunsWith(available.filter(withBody), executor.gate),
        ...agenticRunsWith(available.filter(withBody), executor.layers),
        ...scanRunsWith(available.filter(withBody), executor.scan),
        // The floor canary needs only `Exec`, which the runner's job services supply.
        ...available.filter((run) => run.spec.name === FLOOR_CANARY_NAME),
      ];
};

/** The cloud gate runs of `available`, each with the cloud executor's gate Layers provided; none without them. */
const gateRunsWith = <R extends BodiedRun>(
  available: readonly R[],
  gate: Layer.Layer<CloudGateServices, never, LocalContent> | undefined,
) =>
  gate === undefined
    ? []
    : available
        .filter((run) => isCloudGateRun(run.spec.name))
        .map((run) => ({
          ...run,
          layer: (run.layer as Layer.Layer<never, never, CloudGateServices>).pipe(
            Layer.provide(gate),
          ),
        }));

/** The agentic recipes of `available`, each with the cloud executor's agentic Layers built per execution; none without them. */
const agenticRunsWith = <R extends BodiedRun>(
  available: readonly R[],
  layers: Layer.Layer<CloudAgenticServices, LeaseLayerFailure, LeaseLayerContext> | undefined,
) =>
  layers === undefined
    ? []
    : available
        .filter((run) => AGENTIC_NAMES.has(run.spec.name))
        .map((run) => perExecution(run, layers));

/** The scan runs of `available`, each with the cloud executor's scan Layers built per execution; none without them. */
const scanRunsWith = <R extends BodiedRun>(
  available: readonly R[],
  scan:
    | Layer.Layer<Exclude<ScanServices, Intents>, LeaseLayerFailure, LeaseLayerContext>
    | undefined,
) =>
  scan === undefined
    ? []
    : available
        .filter((run) => SCAN_NAMES.has(run.spec.name))
        .map((run) => perExecution(run, scan));
