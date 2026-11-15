// The synthetic webhook canary's run (specs/operability.md § Liveness, FD-OPS-038 to FD-OPS-040): the push of the
// `canary.push` ops intent to the fixture repository's canary branch admits it as an ops run of class `required`, and
// it concludes its check `success` without a sandbox call. This module imports no process or file API.
import { Schema } from "effect";
import type { CatalogEntry, RunSpecFields } from "./spec.ts";

/** The run the canary webhook admits (FD-OPS-039). */
export const CANARY_RUN = "canary";

/** The canary branch of the fixture repository, which the `canary.push` applier commits to (FD-OPS-038). */
export const CANARY_BRANCH = "flare-dispatch-canary";

/** The canary's class: `required`, the one firm class (FD-OPS-039). */
export const CANARY_CLASS = "required";

export const CANARY_MAX_DURATION_SEC = 300;

/** The canary push: the fixture repository, the pushed commit and the canary branch's ref. */
export const CanaryInput = Schema.Struct({
  repo: Schema.NonEmptyString,
  sha: Schema.String,
  ref: Schema.String,
});
export type CanaryInput = typeof CanaryInput.Type;

/**
 * The canary's declaration: it requires no capability, so it makes no sandbox call and runs in the `control` pool with
 * no Container (MAMEKO-EXEC-057); it declares no grant and no intent kind.
 */
export const canarySpec: RunSpecFields = {
  name: CANARY_RUN,
  version: "2.0.0",
  requires: [],
  labels: [],
  limits: {
    maxDurationSec: CANARY_MAX_DURATION_SEC,
    qosClass: CANARY_CLASS,
    qosCeiling: CANARY_CLASS,
  },
  retries: 0,
  constraints: [],
  grants: { setup: [], agent: [] },
  outputPaths: [],
  needsModel: false,
  intentKinds: [],
};

/** The canary's catalogue entry: no repository manifest lists it, and the `control` pool serves it at no container rate. */
export const canaryEntry: CatalogEntry = {
  spec: canarySpec,
  input: CanaryInput,
  defaultClass: CANARY_CLASS,
  manifestKey: null,
  executors: ["control"],
  containerRateUsdPerHour: 0,
  appCapabilities: [],
  hostExecution: false,
  workflowVersion: 1,
  sealedSandbox: true,
};
