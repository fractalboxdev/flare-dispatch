// The run catalogue of a Container pool's device executor, the module `scripts/build-pool-catalog.ts` bundles with the
// runner (MAMEKO-EXEC-144). It exports `runs`: every run whose catalogue entry lists `cloud` and that is no host
// execution, with the Container as the job sandbox.
//
// - The cloud gate runs, `worker-deploy` and `sandbox-image`, take the device's Layers for processes, artifacts and
//   GitHub reads, and the deploy ledger the control plane holds, since a Container's file system does not outlive a
//   reclaim.
// - The agentic recipes and the scan runs take Layers built inside each execution from its lease
//   (`container-layers.ts`): the values the control plane writes into the lease's input under `cloudLease`, and the
//   payload's execution id and epoch, workspace and artifact store the runner gives the run. A lease without those
//   values ends the run `infra: CloudLeaseMissing`.
import type { Deployment } from "@fractalboxdev/flare-dispatch-profile";
import { Layer } from "effect";
import { containerAgenticLayers, containerScanLayers } from "./container-layers.ts";
import { deviceLayers, runsFor } from "./runs.ts";
import { deploymentOf } from "./spec.ts";
import { httpDeployLedger } from "./worker-deploy.ts";

/**
 * The edit loop's command: the image's coding-agent entry. The gate image installs no coding agent, so the edit loop
 * ends unstarted and a recipe that needs it records `infra: edit loop unavailable` (FD-AGT-067).
 */
export const EDIT_LOOP_COMMAND: readonly [string, ...string[]] = ["fd-edit-loop"];

/** The process's `fetch` at the time of each request; every request leaves through the Container's outbound handler. */
const jobFetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);

/** The runs a Container pool's device executor serves under a deployment. */
export const cloudRuns = (deployment: Deployment) =>
  runsFor(deployment, {
    kind: "cloud",
    gate: Layer.merge(deviceLayers, httpDeployLedger(globalThis.fetch)),
    layers: containerAgenticLayers({
      fetch: jobFetch,
      env: process.env,
      editLoop: EDIT_LOOP_COMMAND,
    }),
    scan: containerScanLayers(jobFetch),
  });

export const runs = cloudRuns(deploymentOf(process.env["FD_DEPLOYMENT"]));
