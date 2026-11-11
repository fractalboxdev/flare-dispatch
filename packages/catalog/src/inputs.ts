// Every gate run's input schema and run ceiling. This module imports no process or file API, so the control plane's
// Worker decodes the same inputs the runner child executes.
import { Schema } from "effect";
import {
  CacheEntrySchema,
  CheckEntrySchema,
  GateContextFields,
  MatrixEntrySchema,
  SandboxImageEntrySchema,
  WorkerDeployEntrySchema,
  WritebackSchema,
} from "./manifest.ts";

/** Run ceilings (specs/runs/gate.md § Recipes). */
export const CHECK_MAX_DURATION_SEC = 4500;
export const OXLINT_MAX_DURATION_SEC = 600;
export const OFFLOAD_TEST_MAX_DURATION_SEC = 3600;
export const WORKER_DEPLOY_MAX_DURATION_SEC = 1800;
export const DEPLOY_SMOKE_MAX_DURATION_SEC = 300;
export const SANDBOX_IMAGE_MAX_DURATION_SEC = 3600;
/** The run ceiling of `gate-job`, the run of one matrix job. */
export const GATE_JOB_MAX_DURATION_SEC = 3600;

/** A matrix job's timeout when it names none. */
export const DEFAULT_JOB_TIMEOUT_SEC = 900;

/** The job timeout of a `check` step that names none (FD-GATE-019). */
export const DEFAULT_STEP_TIMEOUT_SEC = 600;

/** One command of a `check` execution, taken from the manifest entry or the dispatch inputs (FD-GATE-001). */
export const CheckStep = CheckEntrySchema;
export type CheckStep = typeof CheckStep.Type;

export const CheckInput = Schema.Struct({
  ...GateContextFields,
  /** The entry's label; the execution reports under `flare-dispatch/check:<label>` (FD-GATE-020). */
  label: Schema.optionalKey(Schema.String),
  steps: Schema.Array(CheckStep).check(Schema.isMinLength(1)),
});
export type CheckInput = typeof CheckInput.Type;

export const OxlintInput = Schema.Struct({
  ...GateContextFields,
  version: Schema.optionalKey(Schema.String),
});
export type OxlintInput = typeof OxlintInput.Type;

/** The input of one job of a job matrix, which the parent starts as a child execution. */
export const GateJobInput = Schema.Struct({
  ...GateContextFields,
  key: Schema.String,
  command: Schema.String,
  install: Schema.optionalKey(Schema.String),
  timeoutSec: Schema.optionalKey(Schema.Number),
  /** `FD_SHARD_INDEX` and `FD_SHARD_TOTAL` of a sharded job (FD-GATE-034). */
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  cache: Schema.optionalKey(Schema.Array(CacheEntrySchema)),
  writeback: Schema.optionalKey(WritebackSchema),
});
export type GateJobInput = typeof GateJobInput.Type;

export const OffloadTestInput = Schema.Struct({
  ...GateContextFields,
  entry: MatrixEntrySchema,
  /** The parent's own dedup key, from which each job's derives (FD-GATE-031). */
  parentDedupKey: Schema.NonEmptyString,
  trigger: Schema.Literals(["pull_request", "merge_group", "push-default", "other"]),
  /** The base commit a discovery runs on (FD-GATE-048); the head commit where none applies. */
  baseSha: Schema.optionalKey(Schema.String),
  /** The default branch a release tag must be reachable from (FD-GATE-054). */
  defaultBranch: Schema.optionalKey(Schema.String),
});
export type OffloadTestInput = typeof OffloadTestInput.Type;

export const WorkerDeployInput = Schema.Struct({
  ...GateContextFields,
  /** `<owner>/<repo>`. */
  scope: Schema.NonEmptyString,
  /** The deploy branch: `workerDeploy.branch`, else the default branch. */
  branch: Schema.NonEmptyString,
  entry: WorkerDeployEntrySchema,
});
export type WorkerDeployInput = typeof WorkerDeployInput.Type;

export const DeploySmokeInput = Schema.Struct({
  scope: Schema.NonEmptyString,
  sha: Schema.String,
  hosts: Schema.Array(Schema.String),
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
  /** A `deployment_status` event's `environment_url`; its host must be in `hosts` (FD-GATE-073). */
  targetUrl: Schema.optionalKey(Schema.String),
});
export type DeploySmokeInput = typeof DeploySmokeInput.Type;

export const SandboxImageInput = Schema.Struct({
  ...GateContextFields,
  entry: SandboxImageEntrySchema,
  /** `true` on a default-branch push (FD-GATE-077), `false` on a pull request (FD-GATE-076). */
  publish: Schema.Boolean,
  /** The labels the claiming executor advertises (specs/executors.md § Capability labels). */
  executorLabels: Schema.Array(Schema.String),
});
export type SandboxImageInput = typeof SandboxImageInput.Type;
