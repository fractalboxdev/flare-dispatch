// The drift check: a rendered configuration against the template's invariants, the environment schema, the pool
// caps and mameko's profile validator; the deployed Workers against the record of the last deploy; the GitHub App's
// registration against the committed manifest (specs/operability.md § Drift check); and, for a deploy that carries
// the `aws` kind, the AWS account's Budgets actions against the AWS limit (FD-EXEC-083). Every check here is a pure
// function of what it compares; `fd deploy` and `fd doctor` read the inputs through the ports of deploy.ts.
import {
  checkRegistry,
  validateDeclaration,
  type RegistryEntry,
} from "@fractalboxdev/flare-dispatch-agentic";
import {
  loadProfile,
  poolAdmissionCaps,
  profileLoader,
  type ValidationContext,
} from "@fractalboxdev/flare-dispatch-profile";
import type { ProfileDocument } from "@fractalboxdev/mameko-ports";
import { Effect, Schema } from "effect";
import {
  accessChanges,
  accessShape,
  type CommittedAccess,
  type DeployedAccessApplication,
} from "./access-application.ts";
import { placeholdersOf, type WorkerConfig } from "./render.ts";

/** One finding of the drift check. A `warning` is reported and does not fail the check (FD-OPS-023). */
export const Finding = Schema.Struct({
  check: Schema.String,
  path: Schema.String,
  detail: Schema.String,
  severity: Schema.Literals(["failure", "warning"]),
});
export type Finding = typeof Finding.Type;

const fail = (check: string, path: string, detail: string): Finding => ({
  check,
  path,
  detail,
  severity: "failure",
});

const isPlaceholder = (v: unknown): boolean => typeof v === "string" && /^\{\{[^}]+\}\}$/.test(v);

const arr = (v: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];

/** The account-specific fields of a Worker template, each of which must be a placeholder (FD-OPS-001). */
const accountSpecific = (c: WorkerConfig): readonly { path: string; value: unknown }[] => [
  ...("account_id" in c ? [{ path: "account_id", value: c["account_id"] }] : []),
  ...arr(c["d1_databases"]).map((d, i) => ({
    path: `d1_databases[${i}].database_id`,
    value: d["database_id"],
  })),
  ...arr(c["kv_namespaces"]).map((k, i) => ({ path: `kv_namespaces[${i}].id`, value: k["id"] })),
  ...arr(c["r2_buckets"]).map((b, i) => ({
    path: `r2_buckets[${i}].bucket_name`,
    value: b["bucket_name"],
  })),
  ...arr(c["routes"]).map((r, i) => ({ path: `routes[${i}].pattern`, value: r["pattern"] })),
];

/** The cron set every template with a Worker script declares: the single minute tick (FD-INT-050). */
export const MINUTE_TICK = "* * * * *";

const cronsOf = (c: WorkerConfig): readonly string[] => {
  const triggers = c["triggers"];
  return typeof triggers === "object" &&
    triggers !== null &&
    Array.isArray((triggers as { crons?: unknown }).crons)
    ? (triggers as { crons: string[] }).crons
    : [];
};

/**
 * The template's own invariants (FD-OPS-001, FD-OPS-012, FD-INT-050). The minute-tick check applies to every template
 * but a static-assets one (`assets` and no `main`): that Worker, such as the documentation site, runs no scheduled
 * handler, so any cron trigger on it fails the check.
 */
export const templateInvariants = (worker: string, template: WorkerConfig): readonly Finding[] => [
  ...accountSpecific(template)
    .filter((f) => !isPlaceholder(f.value))
    .map((f) =>
      fail("placeholder", `${worker}.${f.path}`, "an account-specific value is not a placeholder"),
    ),
  ...(template["keep_vars"] === false
    ? []
    : [fail("keep_vars", `${worker}.keep_vars`, "every template sets keep_vars to false")]),
  ...(isStaticAssets(template)
    ? staticCronCheck(worker, cronsOf(template))
    : cronCheck(worker, cronsOf(template))),
];

/** A Worker that serves static assets with no Worker script. */
const isStaticAssets = (c: WorkerConfig): boolean =>
  c["main"] === undefined && c["assets"] !== undefined;

/** A cron trigger on a Worker with no script, which has no scheduled handler to run. */
const staticCronCheck = (worker: string, crons: readonly string[]): readonly Finding[] =>
  crons.length === 0
    ? []
    : [
        fail(
          "cron",
          `${worker}.triggers.crons`,
          `cron set ${JSON.stringify(crons)} on a Worker with no script`,
        ),
      ];

/** A cron set other than the single minute tick (FD-INT-050). */
export const cronCheck = (worker: string, crons: readonly string[]): readonly Finding[] =>
  crons.length === 1 && crons[0] === MINUTE_TICK
    ? []
    : [
        fail(
          "cron",
          `${worker}.triggers.crons`,
          `cron set ${JSON.stringify(crons)} is not ["${MINUTE_TICK}"]`,
        ),
      ];

/** Every binding name a configuration declares. */
export const bindingsOf = (c: WorkerConfig): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const key of [
    "d1_databases",
    "kv_namespaces",
    "r2_buckets",
    "services",
    "queues",
    "send_email",
  ])
    for (const b of arr(c[key]))
      if (typeof b["binding"] === "string") names.add(b["binding"]);
      else if (typeof b["name"] === "string") names.add(b["name"]);
  const dobs = (c["durable_objects"] as { bindings?: unknown } | undefined)?.bindings;
  for (const b of arr(dobs)) if (typeof b["name"] === "string") names.add(b["name"]);
  const vars = c["vars"];
  if (typeof vars === "object" && vars !== null) for (const k of Object.keys(vars)) names.add(k);
  return names;
};

/** A binding the control plane's environment schema declares and the rendered configuration lacks (FD-OPS-019). */
export const bindingCheck = (
  worker: string,
  rendered: WorkerConfig,
  declared: readonly string[],
): readonly Finding[] => {
  const present = bindingsOf(rendered);
  return declared
    .filter((b) => !present.has(b))
    .map((b) => fail("binding", `${worker}.${b}`, `binding ${b} is absent`));
};

/** The Container class that backs a pool: `<Pool>Pool`, as `lean` → `LeanPool`. */
export const containerClassOf = (pool: string): string =>
  `${pool.charAt(0).toUpperCase()}${pool.slice(1)}Pool`;

/**
 * Each pool's admission cap must be strictly below its Container class's `max_instances` (FD-OPS-020, FD-PROF-033,
 * MAMEKO-ADM-046); a pool with no Container class fails too (FD-ARCH-001).
 */
export const admissionCapCheck = (
  worker: string,
  rendered: WorkerConfig,
  caps: Readonly<Record<string, { readonly admission_cap: number }>> = poolAdmissionCaps,
): readonly Finding[] => {
  const containers = arr(rendered["containers"]);
  return Object.entries(caps).flatMap(([pool, { admission_cap }]) => {
    const cls = containerClassOf(pool);
    const c = containers.find((x) => x["class_name"] === cls);
    if (c === undefined)
      return [
        fail(
          "admission-cap",
          `${worker}.containers.${cls}`,
          `pool ${pool} has no Container class ${cls}`,
        ),
      ];
    const max = c["max_instances"];
    return typeof max === "number" && admission_cap < max
      ? []
      : [
          fail(
            "admission-cap",
            `${worker}.containers.${cls}.max_instances`,
            `pool ${pool}: admission cap ${admission_cap} is not below max_instances ${String(max)}`,
          ),
        ];
  });
};

/** A placeholder left in rendered configuration. */
export const unrenderedCheck = (worker: string, rendered: string): readonly Finding[] =>
  placeholdersOf(rendered).map((p) =>
    fail("render", `${worker}.${p}`, "placeholder left unrendered"),
  );

/**
 * The provider registry the overlay holds, against the route kinds configuration validation accepts (FD-MDL-020) and
 * each `workers-ai` entry's per-token rate against its Neurons price (FD-MDL-022): one failure per rejected entry.
 */
export const modelRegistryCheck = (entries: readonly RegistryEntry[]): readonly Finding[] =>
  checkRegistry(entries).map((r) => fail("model-registry", `models.registry.${r.entry}`, r.reason));

/** The agentic recipes of the run catalogue a deploy carries, each by run name with its declaration. */
export type AgenticRegistry = Readonly<Record<string, { readonly declaration: unknown }>>;

/**
 * The registry validator over the agentic recipes' declarations (specs/runs/agentic.md § Declaration and catalog): one
 * failure per rejection of `validateDeclaration`, among them a call site without its tier, a declaration without its
 * data classes or its intent kinds (FD-AGT-002), and one that sets `privateData`, `untrustedInput` and `outbound`
 * together (FD-AGT-004).
 */
export const agenticRegistryCheck = (registry: AgenticRegistry): readonly Finding[] =>
  Object.entries(registry).flatMap(([run, entry]) =>
    validateDeclaration(run, entry.declaration).map((r) =>
      fail("agentic-registry", `runs.${r.run}.declaration`, r.reason),
    ),
  );

/** mameko's profile validator over the document the deploy carries, every rejection listed (FD-OPS-021). */
export const profileCheck = (document: ProfileDocument, context: ValidationContext) =>
  loadProfile(profileLoader(context), document).pipe(
    Effect.as([] as readonly Finding[]),
    Effect.catchTag("ProfileRejected", (rejected) =>
      Effect.succeed(
        rejected.rejections.map((r) => fail("profile", r.path === "" ? r.item : r.path, r.reason)),
      ),
    ),
  );

/**
 * The drift check's composition: the configuration checks' findings, then the profile step's (FD-OPS-021,
 * `FdFormal.Drift.driftFindings`). The pull-request drift check, `fd deploy` and `fd doctor` all compose through it.
 */
export const withProfileStep = <E, R>(
  configFindings: readonly Finding[],
  profile: Effect.Effect<readonly Finding[], E, R>,
) => profile.pipe(Effect.map((p): readonly Finding[] => [...configFindings, ...p]));

/** The drift check's findings over one deploy, the profile step over the document the deploy carries (FD-OPS-021). */
export const driftCheckFindings = (
  configFindings: readonly Finding[],
  document: ProfileDocument,
  context: ValidationContext,
) => withProfileStep(configFindings, profileCheck(document, context));

/** The deployed settings of one Worker the drift check compares; secrets by name only. */
export const DeployedSettings = Schema.Struct({
  bindings: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.String,
      target: Schema.optional(Schema.String),
    }),
  ),
  vars: Schema.Record(Schema.String, Schema.String),
  secrets: Schema.Array(Schema.String),
  crons: Schema.Array(Schema.String),
  routes: Schema.Array(Schema.String),
  compatibility_date: Schema.String,
  compatibility_flags: Schema.Array(Schema.String),
  containers: Schema.Array(
    Schema.Struct({
      class_name: Schema.String,
      max_instances: Schema.Number,
      image: Schema.String,
    }),
  ),
});
export type DeployedSettings = typeof DeployedSettings.Type;

const keyed = <T>(xs: readonly T[], key: (x: T) => string): Map<string, T> =>
  new Map(xs.map((x) => [key(x), x]));

const show = (v: unknown): string => (v === undefined ? "absent" : JSON.stringify(v));

/**
 * Each deployed setting that differs from the record of the last deploy, with both values; a secret shows by name
 * only (FD-OPS-016, FD-OPS-017).
 */
export const settingsDrift = (
  worker: string,
  recorded: DeployedSettings,
  deployed: DeployedSettings,
): readonly Finding[] => {
  const out: Finding[] = [];
  const diff = (path: string, rec: unknown, dep: unknown) => {
    if (show(rec) !== show(dep))
      out.push(
        fail("settings", `${worker}.${path}`, `deployed ${show(dep)}, recorded ${show(rec)}`),
      );
  };
  const rb = keyed(recorded.bindings, (b) => b.name);
  const db = keyed(deployed.bindings, (b) => b.name);
  for (const name of new Set([...rb.keys(), ...db.keys()]))
    diff(`bindings.${name}`, rb.get(name), db.get(name));
  for (const name of new Set([...Object.keys(recorded.vars), ...Object.keys(deployed.vars)]))
    diff(`vars.${name}`, recorded.vars[name], deployed.vars[name]);
  const rs = new Set(recorded.secrets);
  const ds = new Set(deployed.secrets);
  for (const name of new Set([...rs, ...ds]))
    if (rs.has(name) !== ds.has(name))
      out.push(
        fail(
          "settings",
          `${worker}.secrets.${name}`,
          `secret ${name} ${ds.has(name) ? "present" : "absent"} on the deployed Worker, ${rs.has(name) ? "present" : "absent"} in the record`,
        ),
      );
  diff("crons", [...recorded.crons].sort(), [...deployed.crons].sort());
  diff("routes", [...recorded.routes].sort(), [...deployed.routes].sort());
  diff("compatibility_date", recorded.compatibility_date, deployed.compatibility_date);
  diff(
    "compatibility_flags",
    [...recorded.compatibility_flags].sort(),
    [...deployed.compatibility_flags].sort(),
  );
  const rc = keyed(recorded.containers, (c) => c.class_name);
  const dc = keyed(deployed.containers, (c) => c.class_name);
  for (const name of new Set([...rc.keys(), ...dc.keys()]))
    diff(`containers.${name}`, rc.get(name), dc.get(name));
  return out;
};

/** A GitHub App's permissions and events, as the App manifest and the registration both state them. */
export const AppPermissions = Schema.Struct({
  default_permissions: Schema.Record(Schema.String, Schema.Literals(["read", "write", "admin"])),
  default_events: Schema.Array(Schema.String),
});
export type AppPermissions = typeof AppPermissions.Type;

const LEVEL = { read: 1, write: 2, admin: 3 } as const;

/**
 * The registration fails where it lacks a manifest permission, grants it at a lower level or lacks a manifest event
 * (FD-OPS-022), and warns where it subscribes to an event the manifest does not list (FD-OPS-023).
 */
export const appRegistrationCheck = (
  manifest: AppPermissions,
  registered: AppPermissions,
): readonly Finding[] => [
  ...Object.entries(manifest.default_permissions).flatMap(([perm, level]) => {
    const got = registered.default_permissions[perm];
    return got !== undefined && LEVEL[got] >= LEVEL[level]
      ? []
      : [
          fail(
            "github-app",
            `permissions.${perm}`,
            `manifest ${level}, registered ${got ?? "absent"}`,
          ),
        ];
  }),
  ...manifest.default_events
    .filter((e) => !registered.default_events.includes(e))
    .map((e) =>
      fail("github-app", `events.${e}`, "a manifest event the registration does not subscribe to"),
    ),
  ...registered.default_events
    .filter((e) => !manifest.default_events.includes(e))
    .map((e): Finding => ({
      check: "github-app",
      path: `events.${e}`,
      detail: "the registration subscribes to an event the manifest does not list",
      severity: "warning",
    })),
];

/** The merge gate's checks, which the default branch's ruleset requires (FD-VER-023). */
export const MERGE_GATE_CHECKS = [
  "lint",
  "typecheck",
  "spec-tags",
  "unit",
  "conf",
  "sim",
  "replay",
  "e2e-local",
  "deploy-dry-run",
  "profile-reference",
  "formal",
  "diff",
] as const;

/** A merge-gate check the ruleset does not require, and `flare-dispatch/check:ci` (FD-VER-023, FD-OPS-028). */
export const rulesetCheck = (required: readonly string[]): readonly Finding[] =>
  [...MERGE_GATE_CHECKS, "flare-dispatch/check:ci"]
    .filter((c) => !required.includes(c))
    .map((c) =>
      fail("ruleset", `required_status_checks.${c}`, `the ruleset does not require ${c}`),
    );

/**
 * The hostname application's AUD tag against the overlay's `access.aud` (FD-OPS-064, FD-OPS-088). The dispatcher checks
 * every Access JWT against `access.aud`, so on a mismatch it rejects each request Access lets through. No finding when
 * the account holds no application on the hostname.
 */
export const accessAudCheck = (
  committed: CommittedAccess,
  deployed: readonly DeployedAccessApplication[],
): readonly Finding[] => {
  const app = deployed.find((d) => d.domain === committed.hostname);
  if (app === undefined || app.aud === committed.aud) return [];
  return [
    fail(
      "access",
      `access.${committed.hostname}.aud`,
      `the hostname's Access application has AUD ${show(app.aud)}, the overlay's access.aud is ${JSON.stringify(committed.aud)}: set access.aud to the application's AUD and deploy again`,
    ),
  ];
};

/**
 * Each difference between the Access applications on the dispatcher's hostname and the committed ones (FD-OPS-088): a
 * committed application absent, one whose name, domain, session or policies differ, one the commit does not hold, and
 * a hostname application whose AUD tag is not the overlay's `access.aud`.
 */
export const accessDrift = (
  committed: CommittedAccess,
  deployed: readonly DeployedAccessApplication[],
): readonly Finding[] => {
  const changes = accessChanges(committed, deployed);
  const live = new Map(deployed.map((d) => [d.id, d]));
  return [
    ...changes.create.map((a) =>
      fail("access", `access.${a.domain}`, "a committed Access application is absent"),
    ),
    ...changes.update.map((u) =>
      fail(
        "access",
        `access.${u.application.domain}`,
        `deployed ${JSON.stringify(accessShape(live.get(u.id)!))}, committed ${JSON.stringify(accessShape(u.application))}`,
      ),
    ),
    ...changes.remove.map((r) =>
      fail(
        "access",
        `access.${r.domain}`,
        "an Access application on the dispatcher's hostname the committed configuration does not hold",
      ),
    ),
    ...accessAudCheck(committed, deployed),
  ];
};

/** One budget of the deploying organization's AWS account, as AWS Budgets `DescribeBudgets` reports it. */
export const AwsBudget = Schema.Struct({
  name: Schema.String,
  /** `COST`, `USAGE` and the reservation and savings-plan types. */
  type: Schema.String,
  limitAmount: Schema.Number,
  limitUnit: Schema.String,
  /** The period the budget's spend resets on: `DAILY`, `MONTHLY`, `QUARTERLY`, `ANNUALLY` or `CUSTOM`. */
  timeUnit: Schema.String,
  /** The budget's cost filters, by dimension; empty for a budget that measures the account's whole spend. */
  costFilters: Schema.Record(Schema.String, Schema.Array(Schema.String)),
});
export type AwsBudget = typeof AwsBudget.Type;

/** One statement of an IAM policy or SCP document. */
export const AwsPolicyStatement = Schema.Struct({
  /** `Allow` or `Deny`. */
  effect: Schema.String,
  /** The `Action` patterns; empty for a statement written with `NotAction`. */
  actions: Schema.Array(Schema.String),
  /** The `Resource` patterns; empty for a statement written with `NotResource`. */
  resources: Schema.Array(Schema.String),
  /** Whether the statement carries a `Condition`. */
  conditional: Schema.Boolean,
});
export type AwsPolicyStatement = typeof AwsPolicyStatement.Type;

/** The policy a Budgets action applies, with the principals or the organization targets it applies the policy to. */
export const AwsActionPolicy = Schema.Struct({
  /** The IAM policy's ARN, or the SCP's policy id. */
  id: Schema.String,
  /** The IAM roles, users and groups; or the SCP's target ids: accounts, organizational units and the root. */
  targets: Schema.Array(Schema.String),
  /** The statements of the policy's document: the IAM policy's default version, or the SCP's content. */
  statements: Schema.Array(AwsPolicyStatement),
});
export type AwsActionPolicy = typeof AwsActionPolicy.Type;

/** One Budgets action of the account, as `DescribeBudgetActionsForAccount` reports it. */
export const AwsBudgetAction = Schema.Struct({
  id: Schema.String,
  budgetName: Schema.String,
  /** `ACTUAL` or `FORECASTED`. */
  notificationType: Schema.String,
  /** `APPLY_IAM_POLICY`, `APPLY_SCP_POLICY` or `RUN_SSM_DOCUMENTS`. */
  actionType: Schema.String,
  /** `AUTOMATIC` or `MANUAL`. */
  approvalModel: Schema.String,
  /** `ABSOLUTE_VALUE`, in the budget's unit, or `PERCENTAGE` of the budget's limit. */
  thresholdType: Schema.String,
  thresholdValue: Schema.Number,
  /** The policy the action's `Definition` applies; null when it names none, as a `RUN_SSM_DOCUMENTS` action does. */
  policy: Schema.NullOr(AwsActionPolicy),
});
export type AwsBudgetAction = typeof AwsBudgetAction.Type;

/** The account the AWS credentials belong to, with its budgets and Budgets actions. */
export const AwsBudgets = Schema.Struct({
  account: Schema.String,
  budgets: Schema.Array(AwsBudget),
  actions: Schema.Array(AwsBudgetAction),
});
export type AwsBudgets = typeof AwsBudgets.Type;

/** The Budgets action types that apply a policy, the form a denial of new task launches takes. */
export const POLICY_ACTION_TYPES: ReadonlySet<string> = new Set([
  "APPLY_IAM_POLICY",
  "APPLY_SCP_POLICY",
]);

/** The ECS calls that start a task: the launches a Budgets action must deny. */
const LAUNCH_CALLS = ["ecs:RunTask", "ecs:StartTask"] as const;

/** The Cost Explorer service the AWS kind's Fargate tasks bill under. */
const ECS_SERVICE = "Amazon Elastic Container Service";

/** Whether an IAM action pattern, with its `*` and `?` wildcards, matches `call`; action names ignore case. */
const actionMatches = (pattern: string, call: string): boolean =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
    "i",
  ).test(call);

/** Whether the statements deny every launch call on every resource, under no condition. */
const deniesLaunches = (statements: readonly AwsPolicyStatement[]): boolean => {
  const denying = statements.filter(
    (s) => s.effect === "Deny" && !s.conditional && s.resources.includes("*"),
  );
  return LAUNCH_CALLS.every((call) =>
    denying.some((s) => s.actions.some((p) => actionMatches(p, call))),
  );
};

/** Why a budget does not measure the AWS kind's spend over the period `aws.budgetUsd` caps; null when it does. */
const budgetGap = (budget: AwsBudget): string | null => {
  if (budget.type !== "COST" || budget.limitUnit !== "USD")
    return `belongs to budget ${budget.name}, which is not a USD cost budget`;
  if (budget.timeUnit === "DAILY")
    return `belongs to budget ${budget.name}, which resets daily and lets a month's spend run past its limit`;
  for (const [dimension, values] of Object.entries(budget.costFilters)) {
    if (values.length === 0) continue;
    if (dimension !== "Service")
      return `belongs to budget ${budget.name}, whose ${dimension} cost filter measures only part of the account's spend`;
    if (!values.includes(ECS_SERVICE))
      return `belongs to budget ${budget.name}, whose Service cost filter leaves out ${ECS_SERVICE}`;
  }
  return null;
};

/** Why an action's policy does not deny the account's launches; null when it does. */
const policyGap = (action: AwsBudgetAction, account: string): string | null => {
  const policy = action.policy;
  if (policy === null) return "names no policy to apply";
  if (!deniesLaunches(policy.statements))
    return `applies policy ${policy.id}, which does not deny ${LAUNCH_CALLS.join(" and ")} on every resource under no condition`;
  if (action.actionType === "APPLY_SCP_POLICY")
    return policy.targets.some((t) => t === account || t.startsWith("r-"))
      ? null
      : `attaches policy ${policy.id} to neither account ${account} nor the organization root`;
  return policy.targets.length === 0
    ? `attaches policy ${policy.id} to no role, user or group`
    : null;
};

/** Why one Budgets action does not deny new task launches when actual spend reaches `limitUsd`; null when it does. */
const budgetActionGap = (
  action: AwsBudgetAction,
  read: AwsBudgets,
  limitUsd: number,
): string | null => {
  if (action.notificationType !== "ACTUAL") return "runs on forecast spend, not actual spend";
  if (!POLICY_ACTION_TYPES.has(action.actionType))
    return `is ${action.actionType}, which applies no deny policy`;
  if (action.approvalModel !== "AUTOMATIC") return "waits for manual approval";
  const budget = read.budgets.find((b) => b.name === action.budgetName);
  if (budget === undefined) return `names budget ${action.budgetName}, which the account lacks`;
  const measured = budgetGap(budget);
  if (measured !== null) return measured;
  const atUsd =
    action.thresholdType === "PERCENTAGE"
      ? (budget.limitAmount * action.thresholdValue) / 100
      : action.thresholdValue;
  // A cent of tolerance absorbs the decimal strings AWS reports amounts in.
  if (atUsd > limitUsd + 0.005) return `runs at ${atUsd} USD, above aws.budgetUsd ${limitUsd} USD`;
  return policyGap(action, read.account);
};

/** The failure of a deploy that carries the `aws` kind and sets no `aws.budgetUsd`; the check reads nothing from AWS. */
export const awsBudgetUnset: Finding = fail(
  "aws-budget",
  "aws.budgetUsd",
  "the overlay carries the aws kind and sets no AWS limit for the Budgets action to enforce",
);

/**
 * The AWS Budgets action MAMEKO-EXEC-087 requires where a deploy carries the `aws` kind (FD-EXEC-083): the account
 * must carry an action that, with no approval step, applies a policy denying `ecs:RunTask` and `ecs:StartTask` on
 * every resource once actual spend reaches the overlay's `aws.budgetUsd`. The action's budget must be a USD cost budget
 * that resets no more often than monthly and measures the ECS spend: unfiltered, or filtered by a Service filter that
 * includes ECS. An SCP must target the account or the organization root; an IAM policy must name at least one role,
 * user or group, since the overlay names no launcher principal to match. An action that runs below the limit
 * qualifies: launches are denied by the time spend reaches it. One failure when no action qualifies, listing why each
 * action read falls short.
 */
export const awsBudgetCheck = (limitUsd: number, read: AwsBudgets): readonly Finding[] => {
  const gaps = read.actions.map((a) => ({ a, gap: budgetActionGap(a, read, limitUsd) }));
  if (gaps.some((g) => g.gap === null)) return [];
  const why =
    gaps.length === 0
      ? "it carries no Budgets action"
      : gaps.map((g) => `action ${g.a.id} ${g.gap!}`).join("; ");
  return [
    fail(
      "aws-budget",
      "aws.budgetAction",
      `AWS account ${read.account} carries no Budgets action that denies new task launches when actual spend reaches aws.budgetUsd ${limitUsd} USD: ${why}`,
    ),
  ];
};

/** Whether any finding fails the check; warnings alone pass. */
export const failed = (findings: readonly Finding[]): boolean =>
  findings.some((f) => f.severity === "failure");
