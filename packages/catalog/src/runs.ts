// The run registry, the only list of runs (FD-RUN-063, MAMEKO-RUN-008). It holds Node process code, so only the
// runner entry and its tests import it. Each executor kind supplies the Layers of the services its runs require.
import type { Deployment } from "@fractalboxdev/flare-dispatch-profile";
import {
  agenticRuns,
  type CloudAgenticServices,
} from "@fractalboxdev/flare-dispatch-agentic/executor";
import { defineRun, type Intents, type LocalContent } from "@fractalboxdev/mameko-run";
import { Effect, Layer } from "effect";
import { runCheck } from "./check.ts";
import { processGateExec, type GateExec } from "./command.ts";
import { runDeploySmoke } from "./deploy-smoke.ts";
import { githubReadLayer, type GithubRead } from "./github-read.ts";
import {
  CheckInput,
  DeploySmokeInput,
  GateJobInput,
  OffloadTestInput,
  OxlintInput,
  SandboxImageInput,
  SecurityGateInput,
  SecurityRescanInput,
  WorkerDeployInput,
} from "./inputs.ts";
import { runGateJob } from "./job.ts";
import { runOffloadTest } from "./offload-test.ts";
import { runOxlint } from "./oxlint.ts";
import { localContentArtifacts, type GateArtifacts } from "./ports.ts";
import { toRunResult } from "./reasons.ts";
import { runSandboxImage } from "./sandbox-image.ts";
import { runSecurityGate, runSecurityRescan, type ScanServices } from "./security-gate.ts";
import {
  checkSpec,
  classRanks,
  deploySmokeSpec,
  gateJobSpec,
  lookupRun,
  offloadTestSpec,
  oxlintSpec,
  sandboxImageSpec,
  securityGateSpec,
  securityRescanSpec,
  workerDeploySpec,
  type ExecutorKind,
  type RunSpecFields,
} from "./spec.ts";
import { runWorkerDeploy } from "./worker-deploy.ts";

const define = <I extends Parameters<typeof defineRun>[0]["input"], R>(
  spec: RunSpecFields,
  input: I,
  body: (input: I["Type"]) => Effect.Effect<Parameters<typeof toRunResult>[0], never, R>,
) =>
  defineRun(
    {
      ...spec,
      input,
      requires: [...spec.requires],
      labels: [...spec.labels],
      constraints: [...spec.constraints],
      grants: { setup: [...spec.grants.setup], agent: [...spec.grants.agent] },
      outputPaths: [...spec.outputPaths],
      intentKinds: [...spec.intentKinds],
    },
    (i) => body(i).pipe(Effect.map(toRunResult)),
    { classRanks },
  );

export const checkRun = define(checkSpec, CheckInput, runCheck);
export const oxlintRun = define(oxlintSpec, OxlintInput, runOxlint);
export const gateJobRun = define(gateJobSpec, GateJobInput, runGateJob);
export const offloadTestRun = define(offloadTestSpec, OffloadTestInput, (i) => runOffloadTest(i));
export const workerDeployRun = define(workerDeploySpec, WorkerDeployInput, runWorkerDeploy);
export const deploySmokeRun = define(deploySmokeSpec, DeploySmokeInput, (i) => runDeploySmoke(i));
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
  securityGateRun,
  securityRescanRun,
  ...agenticRuns,
] as const;

/** Which executor kinds serve a run, from its catalogue entry. */
const servedBy = (name: string, kind: ExecutorKind): boolean => {
  const found = lookupRun("development", name);
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

/** The executor a runner entry serves: the device, or the cloud executor with its agentic Layers. */
export type RunnerExecutor =
  | { readonly kind: "device" }
  | {
      readonly kind: "cloud";
      /** The agentic recipes' services for the execution's job sandbox, from `cloudAgenticLayers`. */
      readonly layers: Layer.Layer<CloudAgenticServices, never, Intents>;
      /**
       * The scan runs' services for the execution's job sandbox: its processes, the scan bundle store, the image, the
       * advisory snapshots and the deployment's scan settings. Without them the cloud executor serves no scan run.
       */
      readonly scan?: Layer.Layer<Exclude<ScanServices, Intents>>;
    };

const AGENTIC_NAMES: ReadonlySet<string> = new Set(agenticRuns.map((run) => run.spec.name));

/** The scan runs the cloud executor serves with its scan Layers (specs/runs/gate.md § Security gate). */
const SCAN_NAMES: ReadonlySet<string> = new Set([
  securityGateRun.spec.name,
  securityRescanRun.spec.name,
]);

/**
 * The runs an executor may execute under a deployment, each with that executor's Layers provided. A run `lookupRun`
 * refuses, that the catalogue does not serve on the executor's kind, or that needs a service the executor lacks is
 * absent, so its lease answers `RunNotInCatalog`. The device serves the gate runs; the cloud executor serves the
 * agentic recipes, whose catalogue entries are cloud-only, and, where it supplies the scan Layers, `security-gate` and
 * `security-rescan`.
 */
export const runsFor = (deployment: Deployment, executor: RunnerExecutor = { kind: "device" }) => {
  const available = registry
    .filter((run) => lookupRun(deployment, run.spec.name)._tag === "Available")
    .filter((run) => servedBy(run.spec.name, executor.kind));
  return executor.kind === "device"
    ? available.map((run) => ({
        ...run,
        layer: (run.layer as Layer.Layer<never, never, GateExec | GateArtifacts | GithubRead>).pipe(
          Layer.provide(deviceLayers),
        ),
      }))
    : [
        ...available
          .filter((run) => AGENTIC_NAMES.has(run.spec.name))
          .map((run) => ({
            ...run,
            layer: (run.layer as Layer.Layer<never, never, CloudAgenticServices>).pipe(
              Layer.provide(executor.layers),
            ),
          })),
        ...scanRunsWith(available, executor.scan),
      ];
};

/** The scan runs of `available`, each with the cloud executor's scan Layers provided; none without them. */
const scanRunsWith = <R extends (typeof registry)[number]>(
  available: readonly R[],
  scan: Layer.Layer<Exclude<ScanServices, Intents>> | undefined,
) =>
  scan === undefined
    ? []
    : available
        .filter((run) => SCAN_NAMES.has(run.spec.name))
        .map((run) => ({
          ...run,
          layer: (run.layer as Layer.Layer<never, never, Exclude<ScanServices, Intents>>).pipe(
            Layer.provide(scan),
          ),
        }));
