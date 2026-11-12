// The catalogue's Worker-safe surface: declarations, inputs, request decoders, outcomes and the egress decision. The
// run bodies and the registry live behind `./runs`, which holds Node process code.
export {
  CHECK_MAX_DURATION_SEC,
  CheckInput,
  CheckStep,
  checkSpec,
  classRanks,
  COMMAND_INPUT_FIELDS,
  commandInputsOf,
  DEFAULT_STEP_TIMEOUT_SEC,
  deploymentOf,
  deploySmokeSpec,
  gateJobSpec,
  lookupRun,
  offloadTestSpec,
  oxlintSpec,
  readOnlyScanRunsOf,
  RUN_CATALOG,
  RUN_NAMES,
  requestPlacement,
  sandboxImagePlacement,
  sandboxImageSpec,
  securityGateSpec,
  securityRescanSpec,
  validateReadOnlyScan,
  workerDeploySpec,
  type CatalogEntry,
  type ReadOnlyScanRejection,
  type RunDeclaration,
  type RunRegistry,
  type ExecutorKind,
  type RunLookup,
  type RunSpecFields,
  type AgenticEntryFields,
} from "./spec.ts";
export * from "./inputs.ts";
export * from "./manifest.ts";
export * from "./reasons.ts";
export * from "./dispatch-event.ts";
export * from "./triggers.ts";
export * from "./github-read.ts";
export * from "./signals.ts";
export * from "./egress.ts";
export {
  deploymentStatusDecoder,
  fetchSmokeHttp,
  runDeploySmoke,
  SmokeHttp,
} from "./deploy-smoke.ts";
export * from "./scan-bundle.ts";
export {
  AdvisorySnapshots,
  AdvisorySnapshotUnreadable,
  ScanBundleStore,
  ScanBundleUnreadable,
  type AdvisorySnapshot,
  ScanImage,
  ScannerVersionUnknown,
} from "./ports.ts";
