// Every gate run's input schema and run ceiling. This module imports no process or file API, so the control plane's
// Worker decodes the same inputs the runner child executes.
import { Data, Schema } from "effect";
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
export const SECURITY_GATE_MAX_DURATION_SEC = 1800;
export const SECURITY_RESCAN_MAX_DURATION_SEC = 1800;
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

const ScanSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));

/**
 * The commit a scan's checkout starts from and the place its range starts: the repository, the head commit and its ref,
 * and the execution's `deadline_at`. A scan run's input holds no command, scanner, flag or skip field (FD-GATE-084), so
 * neither a manifest nor a dispatch changes what the scan runs or whether it runs.
 */
const ScanCommitFields = {
  /** The URL `git fetch` reads the commit from. */
  repo: Schema.NonEmptyString,
  sha: ScanSha,
  ref: Schema.String,
  /** `<owner>/<repo>`. */
  scope: Schema.optionalKey(Schema.String),
  /** The execution's `deadline_at`, epoch milliseconds. */
  deadlineAt: Schema.optionalKey(Schema.Number),
};

/**
 * Where a `security-gate` scan range starts (specs/runs/gate.md § Security gate, step 2): the merge base of the head
 * and the target branch for a pull request, `merge_group.base_sha` for a merge group.
 */
export const SecurityGateBase = Schema.Union([
  Schema.TaggedStruct("TargetBranch", { branch: Schema.NonEmptyString }),
  Schema.TaggedStruct("MergeGroup", { baseSha: ScanSha }),
]);
export type SecurityGateBase = typeof SecurityGateBase.Type;

/** `security-gate`'s input: the head commit and where its scan range starts. */
export const SecurityGateInput = Schema.Struct({
  ...ScanCommitFields,
  base: SecurityGateBase,
});
export type SecurityGateInput = typeof SecurityGateInput.Type;

/**
 * `security-rescan`'s input: the dispatched commit alone, which intake binds to the dispatch (`bindScanCommit`). Its
 * scan range starts at the merge base of that commit and the default branch head, which the checkout reads from the
 * remote, so no input moves it (FD-GATE-112).
 */
export const SecurityRescanInput = Schema.Struct(ScanCommitFields);
export type SecurityRescanInput = typeof SecurityRescanInput.Type;

/** The commit a dispatch's authorization covers: its repository, the commit intake pinned and that commit's ref. */
export interface DispatchCommit {
  /** `<owner>/<repo>`. */
  readonly repository: string;
  readonly sha: string;
  readonly ref: string;
}

/** A dispatch's inputs bound to its authorized commit, or the first commit field the caller set to another value. */
export type CommitBinding = Data.TaggedEnum<{
  Bound: { readonly inputs: unknown };
  Mismatch: { readonly field: string };
}>;
export const CommitBinding = Data.taggedEnum<CommitBinding>();

/** The scan commit fields of a dispatched commit: the repository's clone URL, the commit, its ref and `<owner>/<repo>`. */
export const scanCommitOf = (commit: DispatchCommit) => ({
  repo: `https://github.com/${commit.repository}.git`,
  sha: commit.sha,
  ref: commit.ref,
  scope: commit.repository,
});

/** The commit fields whose values GitHub compares without case: a clone URL and `<owner>/<repo>`. */
const CASELESS_FIELDS: ReadonlySet<string> = new Set(["repo", "scope"]);

/**
 * A `security-rescan` dispatch's inputs with its commit fields taken from the dispatch (FD-GATE-112): the clone URL and
 * `<owner>/<repo>` of the repository the caller is authorized for, and the commit and ref intake pinned. So the commit
 * the run scans, the check it concludes and its summary's `head_sha` are one commit. A field the caller omits is
 * filled; a field it sets to another value is a `Mismatch`, which intake refuses.
 */
export const bindScanCommit = (inputs: unknown, commit: DispatchCommit): CommitBinding => {
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs))
    return CommitBinding.Bound({ inputs });
  const bound = scanCommitOf(commit);
  for (const [field, value] of Object.entries(bound)) {
    if (!Object.hasOwn(inputs, field)) continue;
    const given: unknown = (inputs as Record<string, unknown>)[field];
    const same =
      typeof given === "string" &&
      (CASELESS_FIELDS.has(field) ? given.toLowerCase() === value.toLowerCase() : given === value);
    if (!same) return CommitBinding.Mismatch({ field });
  }
  return CommitBinding.Bound({ inputs: { ...inputs, ...bound } });
};
