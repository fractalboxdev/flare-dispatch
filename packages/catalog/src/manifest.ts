// The repo-manifest fields each gate recipe reads (specs/runs/gate.md § Recipes) and the checks that turn an invalid
// field into `config: <field>` before any command runs. Decoding stays loose where the spec names a config reason, so
// the run, not the payload decoder, answers the bad field. This module imports no process or file API.
import { Schema } from "effect";
import type { Outcome } from "./reasons.ts";
import { Outcome as O } from "./reasons.ts";

/** A check label or job key (FD-GATE-020, FD-GATE-032). */
export const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export const isKey = (value: string): boolean => KEY_PATTERN.test(value);

const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));

/** The authors whose pull requests the gate recipes skip unless the manifest says otherwise (FD-GATE-017). */
export const DEFAULT_SKIP_AUTHORS = ["dependabot[bot]"] as const;

/** The pull request a gate execution answers, where a `pull_request` event started it. */
export const PullRequestFacts = Schema.Struct({
  draft: Schema.Boolean,
  author: Schema.String,
});

/** What every gate job's input carries: the commit and where it came from. */
export const GateContextFields = {
  /** The URL `git fetch` reads the commit from. */
  repo: Schema.NonEmptyString,
  sha: Sha,
  ref: Schema.String,
  /** `<owner>/<repo>`, for `GithubRead`. */
  scope: Schema.optionalKey(Schema.String),
  pullRequest: Schema.optionalKey(PullRequestFacts),
  skipAuthors: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The execution's `deadline_at`, epoch milliseconds. */
  deadlineAt: Schema.optionalKey(Schema.Number),
};
export const GateContext = Schema.Struct(GateContextFields);
export type GateContext = typeof GateContext.Type;

/**
 * `skipped` for a draft pull request or an excluded author, before any command runs (FD-GATE-017); `undefined`
 * otherwise.
 */
export const pullRequestSkip = (ctx: GateContext): Outcome | undefined => {
  if (ctx.pullRequest === undefined) return undefined;
  if (ctx.pullRequest.draft) return O.skipped("draft-pr");
  const excluded = ctx.skipAuthors ?? DEFAULT_SKIP_AUTHORS;
  return excluded.includes(ctx.pullRequest.author) ? O.skipped("author-excluded") : undefined;
};

/** `config: timeoutSec` unless the value is a whole number of seconds from 1 to the run ceiling (FD-GATE-018). */
export const timeoutProblem = (
  timeoutSec: number | undefined,
  ceilingSec: number,
): Outcome | undefined =>
  timeoutSec === undefined ||
  (Number.isInteger(timeoutSec) && timeoutSec >= 1 && timeoutSec <= ceilingSec)
    ? undefined
    : O.failure("config: timeoutSec");

/** A cache entry a manifest names. */
export const CacheEntrySchema = Schema.Struct({
  key: Schema.NonEmptyString,
  paths: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
});

/** A `writeback` block: the branch the staged write proposes and the paths it may carry (FD-GATE-081). */
export const WritebackSchema = Schema.Struct({
  branch: Schema.NonEmptyString,
  paths: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  title: Schema.optionalKey(Schema.String),
});
export type Writeback = typeof WritebackSchema.Type;

/** `check`: one labelled command (FD-GATE-019 to FD-GATE-021). */
export const CheckEntrySchema = Schema.Struct({
  label: Schema.String,
  command: Schema.NonEmptyString,
  timeoutSec: Schema.optionalKey(Schema.Number),
});

/** `oxlint`: the linter version, the recipe's pin by default (FD-GATE-022, FD-GATE-023). */
export const OxlintEntrySchema = Schema.Struct({ version: Schema.optionalKey(Schema.String) });

/** One job of a job matrix. */
export const MatrixJobSchema = Schema.Struct({
  key: Schema.String,
  command: Schema.String,
  shards: Schema.optionalKey(Schema.Number),
  needs: Schema.optionalKey(Schema.Array(Schema.String)),
  heavy: Schema.optionalKey(Schema.Boolean),
  timeoutSec: Schema.optionalKey(Schema.Number),
  retries: Schema.optionalKey(Schema.Number),
  cache: Schema.optionalKey(Schema.Array(CacheEntrySchema)),
  writeback: Schema.optionalKey(WritebackSchema),
});
export type MatrixJob = typeof MatrixJobSchema.Type;

/** `offloadTest`: a job matrix, or one command run as the job `test` (FD-GATE-025). */
export const MatrixEntrySchema = Schema.Struct({
  install: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  jobs: Schema.optionalKey(Schema.Array(MatrixJobSchema)),
  window: Schema.optionalKey(Schema.Number),
  failFast: Schema.optionalKey(Schema.Boolean),
  checkPerJob: Schema.optionalKey(Schema.Boolean),
  discover: Schema.optionalKey(Schema.String),
  release: Schema.optionalKey(Schema.Boolean),
  timeoutSec: Schema.optionalKey(Schema.Number),
});
export type MatrixEntry = typeof MatrixEntrySchema.Type;

/** `workerDeploy` (FD-GATE-061 to FD-GATE-068). */
export const WorkerDeployEntrySchema = Schema.Struct({
  branch: Schema.optionalKey(Schema.String),
  command: Schema.NonEmptyString,
  grants: Schema.optionalKey(Schema.Array(Schema.String)),
  requireHead: Schema.optionalKey(Schema.Boolean),
  timeoutSec: Schema.optionalKey(Schema.Number),
  label: Schema.optionalKey(Schema.String),
});
export type WorkerDeployEntry = typeof WorkerDeployEntrySchema.Type;

/** `deploySmoke` (FD-GATE-070 to FD-GATE-075). */
export const DeploySmokeEntrySchema = Schema.Struct({
  hosts: Schema.Array(Schema.String),
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
  environments: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type DeploySmokeEntry = typeof DeploySmokeEntrySchema.Type;

/** One image of the image family. */
export const ImageSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  /** Workspace-relative Dockerfile. */
  dockerfile: Schema.NonEmptyString,
  context: Schema.optionalKey(Schema.String),
  /** Commands run inside the built image; each must exit 0. */
  smoke: Schema.Array(Schema.String),
});
export type ImageSpec = typeof ImageSchema.Type;

/** `sandboxImage` (FD-GATE-076 to FD-GATE-080, FD-GATE-082). */
export const SandboxImageEntrySchema = Schema.Struct({
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
  images: Schema.Array(ImageSchema).check(Schema.isMinLength(1)),
  /** The registry repository images publish to, `<host>/<path>`. */
  registry: Schema.optionalKey(Schema.String),
});
export type SandboxImageEntry = typeof SandboxImageEntrySchema.Type;

/**
 * The AWS fields of an `imagePublish` or `stackDeploy` entry (FD-GATE-117, FD-GATE-127). Decoding stays loose so the
 * run, not the payload decoder, answers a bad value with `config: <field>`.
 */
export const AwsBuildFields = {
  /** The AWS region of the STS, CodeBuild and ECS endpoints. */
  region: Schema.String,
  /** The IAM role the control plane assumes with its OIDC token. */
  roleArn: Schema.String,
  /** The CodeBuild project the build runs in. */
  project: Schema.String,
};

/** One private release asset a build reads (FD-GATE-129, FD-GATE-130). */
export const ReleaseAssetSchema = Schema.Struct({
  /** The suffix of the asset's build overrides: `FD_ASSET_<key>_URL`, `FD_ASSET_<key>_SHA256`. */
  key: Schema.String,
  /** `<owner>/<repo>` of the release. */
  repo: Schema.String,
  tag: Schema.String,
  /** The asset's file name in the release. */
  name: Schema.String,
  /** The asset's SHA-256, lower-case hex: the asset is pinned by digest and stored at `cas/<sha256>`. */
  sha256: Schema.String,
});
export type ReleaseAsset = typeof ReleaseAssetSchema.Type;

/** `imagePublish` (FD-GATE-116 to FD-GATE-132). */
export const ImagePublishEntrySchema = Schema.Struct({
  ...AwsBuildFields,
  branch: Schema.optionalKey(Schema.String),
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The repository prefixes an image digest may name, `<registry>/<repository path>`. */
  registries: Schema.Array(Schema.String),
  assets: Schema.optionalKey(Schema.Array(ReleaseAssetSchema)),
  /** The `stack-deploy` entry labels a successful publish starts (FD-GATE-132). */
  stacks: Schema.optionalKey(Schema.Array(Schema.String)),
  label: Schema.optionalKey(Schema.String),
});
export type ImagePublishEntry = typeof ImagePublishEntrySchema.Type;

/** The ECS services a stack's rollout waits for (FD-GATE-139, FD-GATE-140). */
export const RolloutSchema = Schema.Struct({
  cluster: Schema.String,
  services: Schema.Array(Schema.String),
  timeoutSec: Schema.optionalKey(Schema.Number),
});
export type Rollout = typeof RolloutSchema.Type;

/** `stackDeploy`, one entry per stack; the entry's label is the stack (FD-GATE-133 to FD-GATE-141). */
export const StackDeployEntrySchema = Schema.Struct({
  ...AwsBuildFields,
  branch: Schema.optionalKey(Schema.String),
  requireHead: Schema.optionalKey(Schema.Boolean),
  approval: Schema.optionalKey(Schema.Literals(["required", "none"])),
  approvalTimeoutSec: Schema.optionalKey(Schema.Number),
  rollout: Schema.optionalKey(RolloutSchema),
  health: Schema.optionalKey(Schema.Struct({ urls: Schema.Array(Schema.String) })),
});
export type StackDeployEntry = typeof StackDeployEntrySchema.Type;

/**
 * `securityGate`, which enrolls a repository in `security-gate` and `security-rescan` (FD-GATE-083). The entry holds no
 * field: the scan bundle the deployment pins fixes the scanners, their flags and their suppression handling, so a
 * repository can name no command, scanner, flag or skip (FD-GATE-084). Any key fails the decode.
 */
export const SecurityGateEntrySchema = Schema.Record(Schema.String, Schema.Never);
export type SecurityGateEntry = typeof SecurityGateEntrySchema.Type;

/** Every gate recipe's manifest key (specs/runs/gate.md § Recipes). */
export const GateManifest = Schema.Struct({
  check: Schema.optionalKey(Schema.Array(CheckEntrySchema)),
  oxlint: Schema.optionalKey(OxlintEntrySchema),
  offloadTest: Schema.optionalKey(MatrixEntrySchema),
  workerDeploy: Schema.optionalKey(WorkerDeployEntrySchema),
  deploySmoke: Schema.optionalKey(DeploySmokeEntrySchema),
  sandboxImage: Schema.optionalKey(SandboxImageEntrySchema),
  securityGate: Schema.optionalKey(SecurityGateEntrySchema),
  imagePublish: Schema.optionalKey(ImagePublishEntrySchema),
  stackDeploy: Schema.optionalKey(Schema.Array(StackDeployEntrySchema)),
  warm: Schema.optionalKey(MatrixJobSchema),
});
export type GateManifest = typeof GateManifest.Type;

/** A path glob: `**` crosses directories, `*` stays inside one. */
export const globMatches = (glob: string, path: string): boolean => {
  const source = glob
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${source}$`).test(path);
};
