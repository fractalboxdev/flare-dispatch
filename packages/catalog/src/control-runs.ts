// The run catalogue of the `control` pool, whose runner runs each run program in a Durable Object of the control plane
// with no Container (MAMEKO-EXEC-057). This module imports no process or file API, so the control plane's Worker binds
// it as the pool controller's `runs()`.
//
// - `deploy-smoke` probes over the Worker's `fetch` (FD-GATE-075).
// - `canary`, the synthetic webhook canary, answers `success` with no service at all (FD-OPS-039).
// - `offload-test`, the job matrix parent, reaches `MatrixChildren` and `GithubRead`, which the control plane builds
//   inside each execution from its `ExecutionLease` (FD-GATE-045).
// - `image-publish` and `stack-deploy` reach CodeBuild and ECS through the control plane's `AwsBuilds`, with the build
//   ledger, staged release assets, the approval record and durable waits (FD-GATE-116 to FD-GATE-141).
import { Effect, Layer } from "effect";
import {
  durablePause,
  type AwsBuilds,
  type BuildLedger,
  type ReleaseAssets,
  type StackApprovals,
} from "./aws.ts";
import { CanaryInput, canarySpec } from "./canary.ts";
import { fetchSmokeHttp, runDeploySmoke } from "./deploy-smoke.ts";
import { perExecution, type ExecutionLease, type LeaseLayerFailure } from "./execution-lease.ts";
import { defineGateRun } from "./gate-run.ts";
import type { GithubRead } from "./github-read.ts";
import { runImagePublish } from "./image-publish.ts";
import {
  DeploySmokeInput,
  ImagePublishInput,
  OffloadTestInput,
  StackDeployInput,
} from "./inputs.ts";
import { runOffloadTest } from "./offload-test.ts";
import type { MatrixChildren } from "./ports.ts";
import { Outcome } from "./reasons.ts";
import { deploySmokeSpec, imagePublishSpec, offloadTestSpec, stackDeploySpec } from "./spec.ts";
import { runStackDeploy } from "./stack-deploy.ts";

export const deploySmokeRun = defineGateRun(deploySmokeSpec, DeploySmokeInput, (i) =>
  runDeploySmoke(i),
);

/** The canary's run: it reaches no service and answers `success`, so its check concludes `success` (FD-OPS-039). */
export const canaryRun = defineGateRun(canarySpec, CanaryInput, () =>
  Effect.succeed(Outcome.success()),
);

/** The job matrix parent: it makes no sandbox call, so its services are the control plane's (FD-GATE-045). */
export const offloadTestRun = defineGateRun(offloadTestSpec, OffloadTestInput, (i) =>
  runOffloadTest(i),
);

/** Each wait is a `DurableClock.sleep` of the execution's workflow, in scope where the body runs (MAMEKO-RUN-037). */
export const imagePublishRun = defineGateRun(imagePublishSpec, ImagePublishInput, (i) =>
  runImagePublish(i).pipe(Effect.provide(durablePause)),
);

export const stackDeployRun = defineGateRun(stackDeploySpec, StackDeployInput, (i) =>
  runStackDeploy(i).pipe(Effect.provide(durablePause)),
);

/** The services the control plane builds for one `offload-test` execution. */
export type ControlRunServices = MatrixChildren | GithubRead;

/** The services the control plane builds for one `image-publish` or `stack-deploy` execution. */
export type AwsRunServices = AwsBuilds | BuildLedger | ReleaseAssets | StackApprovals | GithubRead;

/**
 * The `control` pool's runs, each with the Layers the pool's Durable Object supplies. `services` is built inside each
 * `offload-test` execution from its `ExecutionLease`; a Layer that fails ends the run with `infra: <tag>` before the
 * body starts.
 */
export const controlRuns = (
  services: Layer.Layer<ControlRunServices, LeaseLayerFailure, ExecutionLease>,
  aws: Layer.Layer<AwsRunServices, LeaseLayerFailure, ExecutionLease>,
) =>
  [
    {
      ...deploySmokeRun,
      layer: deploySmokeRun.layer.pipe(Layer.provide(fetchSmokeHttp)),
    },
    canaryRun,
    perExecution(offloadTestRun, services),
    perExecution(imagePublishRun, aws),
    perExecution(stackDeployRun, Layer.merge(aws, fetchSmokeHttp)),
  ] as const;
