// The run catalogue of a Container pool's device executor, the module `scripts/build-pool-catalog.ts` bundles with the
// runner (MAMEKO-EXEC-144). It exports `runs`: the cloud gate runs, `worker-deploy` and `sandbox-image`, with the
// device's Layers for processes, artifacts and GitHub reads, since the Container is the job sandbox, and the deploy
// ledger the control plane holds, since a Container's file system does not outlive a reclaim.
//
// The agentic recipes and the scan runs stay out until a lease carries their per-execution configuration: the model
// gateway's endpoint for the agentic Layers, and the scan bundle, image and advisory snapshots for the scan Layers. The
// bundle's manifest then lists neither, so a lease for one answers `RunNotInCatalog`.
import type { Deployment } from "@fractalboxdev/flare-dispatch-profile";
import { Layer } from "effect";
import { deviceLayers, runsFor } from "./runs.ts";
import { deploymentOf } from "./spec.ts";
import { httpDeployLedger } from "./worker-deploy.ts";

/** The runs a Container pool's device executor serves under a deployment. */
export const cloudRuns = (deployment: Deployment) =>
  runsFor(deployment, {
    kind: "cloud",
    gate: Layer.merge(deviceLayers, httpDeployLedger(globalThis.fetch)),
  });

export const runs = cloudRuns(deploymentOf(process.env["FD_DEPLOYMENT"]));
