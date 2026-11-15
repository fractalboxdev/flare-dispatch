// The run catalogue of the `control` pool, whose runner runs each run program in a Durable Object of the control plane
// with no Container (MAMEKO-EXEC-057). This module imports no process or file API, so the control plane's Worker binds
// it as the pool controller's `runs()`.
//
// - `deploy-smoke` probes over the Worker's `fetch` (FD-GATE-075).
// - `canary`, the synthetic webhook canary, answers `success` with no service at all (FD-OPS-039).
// - `offload-test` needs `MatrixChildren` and `GithubRead`, which no control-pool Layer supplies, so it is not in the
//   catalogue and its lease answers `RunNotInCatalog`.
import { Effect, Layer } from "effect";
import { CanaryInput, canarySpec } from "./canary.ts";
import { fetchSmokeHttp, runDeploySmoke } from "./deploy-smoke.ts";
import { defineGateRun } from "./gate-run.ts";
import { DeploySmokeInput } from "./inputs.ts";
import { Outcome } from "./reasons.ts";
import { deploySmokeSpec } from "./spec.ts";

export const deploySmokeRun = defineGateRun(deploySmokeSpec, DeploySmokeInput, (i) =>
  runDeploySmoke(i),
);

/** The canary's run: it reaches no service and answers `success`, so its check concludes `success` (FD-OPS-039). */
export const canaryRun = defineGateRun(canarySpec, CanaryInput, () =>
  Effect.succeed(Outcome.success()),
);

/** The `control` pool's runs, each with the Layers the pool's Durable Object supplies. */
export const controlRuns = [
  {
    ...deploySmokeRun,
    layer: deploySmokeRun.layer.pipe(Layer.provide(fetchSmokeHttp)),
  },
  canaryRun,
] as const;
