// The run registry, the only list of runs (FD-RUN-063). It holds Node process code, so only the runner entry and its
// tests import it.
import type { Deployment } from "@fractalboxdev/flare-dispatch-profile";
import { defineRun } from "@fractalboxdev/mameko-run";
import { runCheck } from "./check.ts";
import { checkSpec, classRanks, lookupRun } from "./spec.ts";

export const checkRun = defineRun({ ...checkSpec, requires: [...checkSpec.requires] }, runCheck, {
  classRanks,
});

const registry = [checkRun];

/** The runs a deployment may execute; a run `lookupRun` refuses is absent, so its lease answers `RunNotInCatalog`. */
export const runsFor = (deployment: Deployment) =>
  registry.filter((run) => lookupRun(deployment, run.spec.name)._tag === "Available");
