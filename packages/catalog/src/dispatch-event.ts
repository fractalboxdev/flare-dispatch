// `DispatchEvent`: the decoded request union every request decoder of the run catalogue takes (FD-RUN-008,
// MAMEKO-RUN-010), one member per trigger kind of specs/intake.md § Trigger kinds.
import { Schema } from "effect";

const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));

/** The repository a webhook names. */
const Repository = Schema.Struct({
  /** `<owner>/<repo>`, the tenant scope. */
  fullName: Schema.NonEmptyString,
  cloneUrl: Schema.NonEmptyString,
  defaultBranch: Schema.NonEmptyString,
});

const PullRequestDelivery = Schema.Struct({
  event: Schema.Literal("pull_request"),
  action: Schema.String,
  repository: Repository,
  pullRequest: Schema.Struct({
    number: Schema.Number,
    draft: Schema.Boolean,
    author: Schema.String,
    headSha: Sha,
    headRef: Schema.String,
    baseRef: Schema.String,
    baseSha: Sha,
  }),
  /** The paths the pull request changes, as intake read them. */
  changedPaths: Schema.optionalKey(Schema.Array(Schema.String)),
});

const PushDelivery = Schema.Struct({
  event: Schema.Literal("push"),
  action: Schema.Literal(""),
  repository: Repository,
  /** `refs/heads/<branch>` or `refs/tags/<tag>`. */
  ref: Schema.String,
  before: Schema.String,
  after: Sha,
  changedPaths: Schema.optionalKey(Schema.Array(Schema.String)),
});

const MergeGroupDelivery = Schema.Struct({
  event: Schema.Literal("merge_group"),
  action: Schema.String,
  repository: Repository,
  headSha: Sha,
  headRef: Schema.String,
  baseRef: Schema.String,
});

const DeploymentStatusDelivery = Schema.Struct({
  event: Schema.Literal("deployment_status"),
  action: Schema.String,
  repository: Repository,
  state: Schema.String,
  environment: Schema.String,
  environmentUrl: Schema.optionalKey(Schema.String),
  sha: Sha,
  ref: Schema.String,
});

/** A webhook's payload, decoded per event. */
export const WebhookDelivery = Schema.Union([
  PullRequestDelivery,
  PushDelivery,
  MergeGroupDelivery,
  DeploymentStatusDelivery,
]);
export type WebhookDelivery = typeof WebhookDelivery.Type;

export const DispatchEvent = Schema.Union([
  Schema.TaggedStruct("webhook", {
    deliveryId: Schema.NonEmptyString,
    delivery: WebhookDelivery,
  }),
  Schema.TaggedStruct("dispatch", {
    run: Schema.NonEmptyString,
    repo: Schema.NonEmptyString,
    ref: Schema.String,
    sha: Sha,
    inputs: Schema.Unknown,
    class: Schema.optionalKey(Schema.String),
    /** The OIDC subject or the Access identity that dispatched. */
    caller: Schema.String,
  }),
  Schema.TaggedStruct("cron", {
    /** The scheduled minute, ISO 8601 UTC. */
    scheduledMinute: Schema.String,
    repo: Schema.NonEmptyString,
    schedule: Schema.String,
  }),
  Schema.TaggedStruct("local", {
    lease_id: Schema.String,
    epoch: Schema.Number,
    run: Schema.NonEmptyString,
    treeHash: Schema.String,
    inputsDigest: Schema.String,
  }),
  Schema.TaggedStruct("mcp", {
    caller: Schema.String,
    run: Schema.NonEmptyString,
    repo: Schema.NonEmptyString,
    ref: Schema.String,
    sha: Sha,
    inputs: Schema.Unknown,
  }),
]);
export type DispatchEvent = typeof DispatchEvent.Type;

/** The trigger kinds, in the order specs/intake.md lists them. */
export const TRIGGER_KINDS = ["webhook", "dispatch", "cron", "local", "mcp"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];
