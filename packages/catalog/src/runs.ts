// The run registry, the only list of runs (FD-RUN-063, MAMEKO-RUN-008). It holds Node process code, so only the
// runner entry and its tests import it. Each executor kind supplies the Layers of the services its runs require.
import type { Deployment } from "@fractalboxdev/flare-dispatch-profile";
import {
  agenticRuns,
  type CloudAgenticServices,
} from "@fractalboxdev/flare-dispatch-agentic/executor";
import {
  defineRun,
  type Artifact,
  type Exec,
  type Intents,
  type LocalContent,
  type RunResult,
  type Workspace,
} from "@fractalboxdev/mameko-run";
import { Effect, Layer } from "effect";
import { runCheck } from "./check.ts";
import { processGateExec, type GateExec } from "./command.ts";
import { runDeploySmoke } from "./deploy-smoke.ts";
import { ExecutionLease, type LeaseLayerFailure } from "./execution-lease.ts";
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
import { runWorkerDeploy, type DeployLedger } from "./worker-deploy.ts";

/**
 * One gate run through `defineRun`, with its body beside the definition, so an executor whose services depend on the
 * lease builds them inside each execution around the same body.
 */
const define = <I extends Parameters<typeof defineRun>[0]["input"], R>(
  spec: RunSpecFields,
  input: I,
  body: (input: I["Type"]) => Effect.Effect<Parameters<typeof toRunResult>[0], never, R>,
) => {
  const run = (i: I["Type"]) => body(i).pipe(Effect.map(toRunResult));
  return {
    ...defineRun(
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
      run,
      { classRanks },
    ),
    body: run,
  };
};

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

/** The services the gate runs a cloud executor serves require: the device's, and the deploy ledger. */
export type CloudGateServices = GateExec | GateArtifacts | GithubRead | DeployLedger;

/** The runner's services a per-lease Layer may read beside `ExecutionLease`. */
export type LeaseLayerContext = ExecutionLease | Intents | Workspace | Exec | Artifact;

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

/**
 * The gate runs a cloud executor serves with its gate Layers: a run whose catalogue entry lists `cloud`, that is
 * neither agentic nor a scan run, and that is no host execution. A host execution's run is the device runner entry's
 * under `development` only, so the cloud executor serves the same gate runs under both deployments.
 */
const isCloudGateRun = (name: string): boolean => {
  const found = lookupRun("development", name);
  return (
    found._tag === "Available" &&
    !found.entry.hostExecution &&
    !AGENTIC_NAMES.has(name) &&
    !SCAN_NAMES.has(name)
  );
};

/**
 * The runs an executor may execute under a deployment, each with that executor's Layers provided. A run `lookupRun`
 * refuses, that the catalogue does not serve on the executor's kind, or that needs a service the executor lacks is
 * absent, so its lease answers `RunNotInCatalog`. The device serves the gate runs; the cloud executor serves the
 * agentic recipes, whose catalogue entries are cloud-only, where it supplies their Layers; `security-gate` and
 * `security-rescan` where it supplies the scan Layers; and the cloud gate runs where it supplies the gate Layers.
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
        ...gateRunsWith(available, executor.gate),
        ...agenticRunsWith(available, executor.layers),
        ...scanRunsWith(available, executor.scan),
      ];
};

/** The cloud gate runs of `available`, each with the cloud executor's gate Layers provided; none without them. */
const gateRunsWith = <R extends (typeof registry)[number]>(
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

/** What `perExecution` reads of a run: its name, its workflow and the body its `layer` registers. */
interface RunBody {
  readonly spec: { readonly name: string };
  readonly workflow: (typeof registry)[number]["workflow"];
  readonly body: (input: never) => Effect.Effect<RunResult, never, unknown>;
}

/** The run payload fields a per-lease Layer reads. */
interface LeasePayload {
  readonly execution_id: string;
  readonly epoch: number;
  readonly input: unknown;
}

/**
 * `run` with its body registered on the engine inside each execution: `layer` is built there from the payload's
 * execution id, epoch and decoded input as `ExecutionLease`, beside the runner's services, so the one bundle serves
 * every lease. A Layer that fails ends the run with `failure` and `infra: <tag>` before the body starts; no default
 * stands in for a missing value.
 */
const perExecution = <R extends RunBody, A>(
  run: R,
  layer: Layer.Layer<A, LeaseLayerFailure, LeaseLayerContext>,
): R & { readonly layer: Layer.Layer<never, never, unknown> } => {
  const body = run.body as (input: unknown) => Effect.Effect<RunResult, never, A>;
  const workflow = run.workflow as unknown as {
    readonly toLayer: (
      execute: (payload: LeasePayload) => Effect.Effect<RunResult, never, unknown>,
    ) => Layer.Layer<never, never, unknown>;
  };
  return {
    ...run,
    layer: workflow.toLayer((payload) =>
      body(payload.input).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(
              Layer.succeed(ExecutionLease, {
                executionId: payload.execution_id,
                epoch: payload.epoch,
                run: run.spec.name,
                input: payload.input,
              }),
            ),
          ),
        ),
        Effect.catch((failure: LeaseLayerFailure) =>
          Effect.succeed<RunResult>({ _tag: "failure", reason: `infra: ${failure._tag}` }),
        ),
      ),
    ),
  };
};

/** The agentic recipes of `available`, each with the cloud executor's agentic Layers built per execution; none without them. */
const agenticRunsWith = <R extends (typeof registry)[number]>(
  available: readonly R[],
  layers: Layer.Layer<CloudAgenticServices, LeaseLayerFailure, LeaseLayerContext> | undefined,
) =>
  layers === undefined
    ? []
    : available
        .filter((run) => AGENTIC_NAMES.has(run.spec.name))
        .map((run) => perExecution(run, layers));

/** The scan runs of `available`, each with the cloud executor's scan Layers built per execution; none without them. */
const scanRunsWith = <R extends (typeof registry)[number]>(
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
