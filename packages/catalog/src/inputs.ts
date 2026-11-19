// Every gate run's input schema and run ceiling. This module imports no process or file API, so the control plane's
// Worker decodes the same inputs the runner child executes.
import { Data, Option, Schema } from "effect";
import {
  CacheEntrySchema,
  CheckEntrySchema,
  GateContextFields,
  ImagePublishEntrySchema,
  MatrixEntrySchema,
  SandboxImageEntrySchema,
  StackDeployEntrySchema,
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
export const IMAGE_PUBLISH_MAX_DURATION_SEC = 7200;
export const STACK_DEPLOY_MAX_DURATION_SEC = 86_400;
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

/** The control plane's deploy-claim route, one path per execution: `POST /v1/deploy-claims/<execution id>`. */
export const DEPLOY_CLAIM_ROUTE = "/v1/deploy-claims/";

/**
 * The deploy claim of a `worker-deploy` lease: the control plane's route for the execution and the token it minted
 * for the execution at the lease's epoch, which expires at `deadline_at`. The control plane writes it into the lease's
 * input, the one lease field the run payload carries to the run, and drops any value a request recorded there.
 */
export const DeployClaimGrant = Schema.Struct({
  url: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
});
export type DeployClaimGrant = typeof DeployClaimGrant.Type;

export const WorkerDeployInput = Schema.Struct({
  ...GateContextFields,
  /** `<owner>/<repo>`. */
  scope: Schema.NonEmptyString,
  /** The deploy branch: `workerDeploy.branch`, else the default branch. */
  branch: Schema.NonEmptyString,
  entry: WorkerDeployEntrySchema,
  /** The lease's deploy claim; absent on a deploy whose control plane mints none. */
  deployClaim: Schema.optionalKey(DeployClaimGrant),
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

/** An image by digest, `<registry>/<repository>@sha256:<64 hex digits>` (FD-GATE-131, FD-GATE-133). */
export const IMAGE_BY_DIGEST = /^[a-z0-9.-]+(:[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;
export const ImageDigests = Schema.Record(
  Schema.String,
  Schema.String.check(Schema.isPattern(IMAGE_BY_DIGEST)),
);
export type ImageDigests = typeof ImageDigests.Type;

/**
 * The commit an AWS build runs for. Intake sets every field from the trusted event or the parent execution's record;
 * a dispatch supplies no field of it (FD-GATE-128, FD-GATE-133).
 */
const AwsBuildContext = {
  /** `<owner>/<repo>`. */
  scope: Schema.NonEmptyString,
  sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  ref: Schema.String,
};

export const ImagePublishInput = Schema.Struct({
  ...AwsBuildContext,
  entry: ImagePublishEntrySchema,
});
export type ImagePublishInput = typeof ImagePublishInput.Type;

export const StackDeployInput = Schema.Struct({
  ...AwsBuildContext,
  /** The stack: the manifest entry's label. */
  stack: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/)),
  /** The branch whose head the apply re-reads (FD-GATE-135). */
  branch: Schema.NonEmptyString,
  entry: StackDeployEntrySchema,
  /** The images the apply rolls out, from the `image-publish` follow-on or the dispatch (FD-GATE-133). */
  images: ImageDigests,
});
export type StackDeployInput = typeof StackDeployInput.Type;

/** What a dispatch or a follow-on intent of `stack-deploy` supplies: the images alone (FD-GATE-133). */
export const StackDeployRequest = Schema.Struct({ images: ImageDigests });

const ScanSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));

/** One advisory snapshot a scan lease carries: the snapshot the control plane recorded, and a read of its archive. */
export const LeasedAdvisory = Schema.Struct({
  ecosystem: Schema.NonEmptyString,
  /** The SHA-256 of the OSV `all.zip` archive, which `cas/<digest>` holds. */
  digest: Schema.NonEmptyString,
  /** The archive's `Last-Modified` time, epoch ms. */
  lastModified: Schema.Number,
  /** A presigned `GET` of `cas/<digest>`, valid for the presigner's URL lifetime and never past `deadline_at`. */
  url: Schema.NonEmptyString,
});
export type LeasedAdvisory = typeof LeasedAdvisory.Type;

/**
 * A scan lease's executor values, which the control plane writes into the input of a `security-gate` or
 * `security-rescan` lease and the run reads through the egress handler's object-store pass alone (FD-GATE-110): the
 * deployment's `scan.bundleDigest` with a presigned `GET` of `cas/<digest>`, `scan.advisoryMaxAgeHours`, and each
 * recorded advisory snapshot. The control plane drops any value a request recorded under the same key, so no request
 * changes what the scan reads (FD-GATE-084).
 */
export const ScanLease = Schema.Struct({
  /** `scan.bundleDigest`; absent where the overlay pins none (FD-GATE-101). */
  bundleDigest: Schema.optionalKey(Schema.NonEmptyString),
  /** A presigned `GET` of `cas/<bundleDigest>`; absent where the control plane signs none. */
  bundleUrl: Schema.optionalKey(Schema.NonEmptyString),
  advisoryMaxAgeHours: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  advisories: Schema.Array(LeasedAdvisory),
});
export type ScanLease = typeof ScanLease.Type;

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
  /** The lease's scan values; absent on a lease whose control plane writes none. */
  cloudLease: Schema.optionalKey(ScanLease),
};

/**
 * Where a `security-gate` scan range starts (specs/runs/gate.md § Security gate, step 2): the merge base of the head
 * and the target branch for a pull request, `merge_group.base_sha` for a merge group. A pull request's base also names
 * the target branch's head at the event, the commit the execution's source fetches beside the head, so the merge base
 * is in the checkout's history; the scan range still starts at the merge base the checkout computes.
 */
export const SecurityGateBase = Schema.Union([
  Schema.TaggedStruct("TargetBranch", {
    branch: Schema.NonEmptyString,
    baseSha: Schema.optionalKey(ScanSha),
  }),
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
 * The base of a `security-gate` execution's source (MAMEKO-ADM-033): `merge_group.base_sha` for a merge group, the
 * target branch's head at the event for a pull request, and none for an input that names neither or does not decode.
 */
export const securityGateSourceBase = (inputs: unknown): string | null =>
  Option.match(Schema.decodeUnknownOption(SecurityGateInput)(inputs), {
    onNone: () => null,
    onSome: ({ base }) => base.baseSha ?? null,
  });

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
