// The run catalogue of the `control` pool, whose runner runs each run program in a Durable Object of the control plane
// with no Container (MAMEKO-EXEC-057). This module imports no process or file API, so the control plane's Worker binds
// it as the pool controller's `runs()`.
//
// - `deploy-smoke` probes over the Worker's `fetch` (FD-GATE-075).
// - `canary`, the synthetic webhook canary, answers `success` with no service at all (FD-OPS-039).
// - `offload-test`, the job matrix parent, reaches `MatrixChildren` and `GithubRead`, which the control plane builds
//   inside each execution from its `ExecutionLease` (FD-GATE-045).
import { Effect, Layer } from "effect";
import { CanaryInput, canarySpec } from "./canary.ts";
import { fetchSmokeHttp, runDeploySmoke } from "./deploy-smoke.ts";
import { perExecution, type ExecutionLease, type LeaseLayerFailure } from "./execution-lease.ts";
import { defineGateRun } from "./gate-run.ts";
import type { GithubRead } from "./github-read.ts";
import { DeploySmokeInput, OffloadTestInput } from "./inputs.ts";
import { runOffloadTest } from "./offload-test.ts";
import type { MatrixChildren } from "./ports.ts";
import { Outcome } from "./reasons.ts";
import { deploySmokeSpec, offloadTestSpec } from "./spec.ts";

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

/** The services the control plane builds for one `offload-test` execution. */
export type ControlRunServices = MatrixChildren | GithubRead;

/**
 * The `control` pool's runs, each with the Layers the pool's Durable Object supplies. `services` is built inside each
 * `offload-test` execution from its `ExecutionLease`; a Layer that fails ends the run with `infra: <tag>` before the
 * body starts.
 */
export const controlRuns = (
  services: Layer.Layer<ControlRunServices, LeaseLayerFailure, ExecutionLease>,
) =>
  [
    {
      ...deploySmokeRun,
      layer: deploySmokeRun.layer.pipe(Layer.provide(fetchSmokeHttp)),
    },
    canaryRun,
    perExecution(offloadTestRun, services),
  ] as const;
