// The `DispatchEvent` union every run trigger receives decoded (specs/intake.md
// § Records, specs/run-model.md § Triggers), and what intake reads off a webhook
// payload: the repository, the installation, the commit and the fork flag.
import { Option, Schema } from "effect";

export const TriggerKind = Schema.Literals(["webhook", "dispatch", "cron", "local", "mcp"]);
export type TriggerKind = typeof TriggerKind.Type;

/** Who called: an Actions OIDC subject, an Access identity, or the control plane itself. */
export const Caller = Schema.Struct({
  kind: Schema.Literals(["actions-oidc", "access", "control-plane"]),
  id: Schema.String,
  /** The token's `workflow_ref` for an Actions caller. */
  workflowRef: Schema.optionalKey(Schema.String),
  /** The token's `ref` for an Actions caller, `refs/heads/<branch>`. */
  ref: Schema.optionalKey(Schema.String),
});
export type Caller = typeof Caller.Type;

export const WebhookEvent = Schema.TaggedStruct("webhook", {
  event: Schema.String,
  action: Schema.NullOr(Schema.String),
  deliveryId: Schema.String,
  payload: Schema.Unknown,
});
export const DispatchTrigger = Schema.TaggedStruct("dispatch", {
  run: Schema.String,
  repo: Schema.String,
  ref: Schema.String,
  sha: Schema.String,
  inputs: Schema.Unknown,
  class: Schema.NullOr(Schema.String),
  caller: Caller,
});
export const CronTrigger = Schema.TaggedStruct("cron", {
  /** The scheduled minute, epoch ms. */
  scheduledAt: Schema.Number,
  repo: Schema.String,
  schedule: Schema.String,
});
export const LocalTrigger = Schema.TaggedStruct("local", {
  leaseId: Schema.String,
  epoch: Schema.Number,
  run: Schema.String,
  treeHash: Schema.String,
  inputsDigest: Schema.String,
});
export const McpTrigger = Schema.TaggedStruct("mcp", {
  caller: Caller,
  run: Schema.String,
  repo: Schema.String,
  ref: Schema.String,
  sha: Schema.String,
  inputs: Schema.Unknown,
});

/** One member per trigger kind (FD-RUN-008). */
export const DispatchEvent = Schema.Union([
  WebhookEvent,
  DispatchTrigger,
  CronTrigger,
  LocalTrigger,
  McpTrigger,
]);
export type DispatchEvent = typeof DispatchEvent.Type;
export type WebhookEvent = typeof WebhookEvent.Type;

// ---------------------------------------------------------------------------
// Webhook payload fields

const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
const Repo = Schema.Struct({ full_name: Schema.String });

/** The fields intake reads off any webhook payload; every one is optional. */
export const WebhookFields = Schema.Struct({
  action: Schema.optionalKey(Schema.String),
  ref: Schema.optionalKey(Schema.String),
  after: Schema.optionalKey(Schema.String),
  repository: Schema.optionalKey(Repo),
  installation: Schema.optionalKey(Schema.Struct({ id: Schema.Number })),
  deployment: Schema.optionalKey(Schema.Struct({ sha: Schema.optionalKey(Schema.String) })),
  pull_request: Schema.optionalKey(
    Schema.Struct({
      number: Schema.Number,
      head: Schema.Struct({
        sha: Schema.optionalKey(Schema.String),
        ref: Schema.optionalKey(Schema.String),
        repo: Schema.optionalKey(Schema.NullOr(Repo)),
      }),
      base: Schema.Struct({
        ref: Schema.String,
        repo: Schema.optionalKey(Repo),
      }),
    }),
  ),
  merge_group: Schema.optionalKey(
    Schema.Struct({
      head_sha: Schema.optionalKey(Schema.String),
      base_ref: Schema.optionalKey(Schema.String),
    }),
  ),
  head_commit: Schema.optionalKey(Schema.NullOr(Schema.Struct({ id: Schema.String }))),
  check_run: Schema.optionalKey(
    Schema.Struct({
      id: Schema.Number,
      head_sha: Schema.optionalKey(Schema.String),
      external_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
      name: Schema.optionalKey(Schema.String),
      app: Schema.optionalKey(Schema.NullOr(Schema.Struct({ id: Schema.Number }))),
    }),
  ),
  check_suite: Schema.optionalKey(
    Schema.Struct({
      head_sha: Schema.optionalKey(Schema.String),
      app: Schema.optionalKey(Schema.NullOr(Schema.Struct({ id: Schema.Number }))),
    }),
  ),
  repositories_removed: Schema.optionalKey(Schema.Array(Repo)),
});
export type WebhookFields = typeof WebhookFields.Type;

const isSha = Schema.is(Sha);
const present = (v: string | undefined | null): Option.Option<string> =>
  v !== undefined && v !== null && isSha(v) ? Option.some(v) : Option.none();

/**
 * The webhook's commit: the first present of `deployment.sha`, `pull_request.head.sha`, `merge_group.head_sha`,
 * `head_commit.id` on a tag push or `after` on a branch push, `check_run.head_sha` and `check_suite.head_sha`
 * (FD-INT-028).
 */
export const commitOf = (f: WebhookFields): Option.Option<string> => {
  const push =
    f.ref === undefined
      ? Option.none<string>()
      : f.ref.startsWith("refs/tags/")
        ? present(f.head_commit?.id)
        : present(f.after);
  return Option.firstSomeOf([
    present(f.deployment?.sha),
    present(f.pull_request?.head.sha),
    present(f.merge_group?.head_sha),
    push,
    present(f.check_run?.head_sha),
    present(f.check_suite?.head_sha),
  ]);
};

/** A pull request whose head repository is not its base repository is a fork pull request (FD-INT-030). */
export const isForkPr = (f: WebhookFields): boolean => {
  const pr = f.pull_request;
  if (pr === undefined) return false;
  const head = pr.head.repo?.full_name ?? null;
  const base = pr.base.repo?.full_name ?? f.repository?.full_name ?? null;
  return head === null || base === null || head !== base;
};

/**
 * What started an execution as its cache namespaces read it (specs/cache-artifacts.md § Cache namespaces and cache
 * tiers): the pull request's number, a push's ref and whether it is a protected trigger, a merge group, or `Other`.
 */
export const CacheTriggerRecord = Schema.Union([
  Schema.TaggedStruct("PullRequest", { number: Schema.Number }),
  Schema.TaggedStruct("Push", { ref: Schema.String, protected: Schema.Boolean }),
  Schema.TaggedStruct("MergeGroup", {}),
  Schema.TaggedStruct("Other", {}),
]);
export type CacheTriggerRecord = typeof CacheTriggerRecord.Type;

export const OTHER_CACHE_TRIGGER: CacheTriggerRecord = { _tag: "Other" };

/** A `gh-readonly-queue/*` push carries several pull requests' code and is never a protected trigger. */
export const isReadonlyQueueRef = (ref: string) => ref.startsWith("refs/heads/gh-readonly-queue/");

/** The pushed ref whose ruleset and branch protection intake reads; none for a `gh-readonly-queue/*` push. */
export const protectableRefOf = (event: string, f: WebhookFields): string | null =>
  event === "push" && f.ref !== undefined && !isReadonlyQueueRef(f.ref) ? f.ref : null;

/**
 * The cache trigger of a webhook. A push is a protected trigger when it is to the default branch, or to a branch or
 * tag that `refProtected` says a ruleset or branch protection protects; a `gh-readonly-queue/*` push never is.
 */
export const cacheTriggerOf = (
  event: string,
  f: WebhookFields,
  defaultBranch: string,
  refProtected: boolean,
): CacheTriggerRecord => {
  if (event === "pull_request" && f.pull_request !== undefined)
    return { _tag: "PullRequest", number: f.pull_request.number };
  if (event === "merge_group") return { _tag: "MergeGroup" };
  if (event === "push" && f.ref !== undefined)
    return {
      _tag: "Push",
      ref: f.ref,
      protected:
        !isReadonlyQueueRef(f.ref) && (f.ref === `refs/heads/${defaultBranch}` || refProtected),
    };
  return OTHER_CACHE_TRIGGER;
};

/** The trigger a request records: `fork-pr` for a fork pull request, else the trigger kind. */
export type RecordedTrigger = TriggerKind | "fork-pr";
