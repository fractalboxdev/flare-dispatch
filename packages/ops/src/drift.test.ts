import { AGENTIC_CATALOG } from "@fractalboxdev/flare-dispatch-agentic";
import {
  readOnlyScanRunsOf,
  RUN_CATALOG,
  type RunDeclaration,
} from "@fractalboxdev/flare-dispatch-catalog";
import { profileDocumentFor } from "@fractalboxdev/flare-dispatch-profile";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  admissionCapCheck,
  APP_PERMISSIONS,
  appManifest,
  appRegistrationCheck,
  awsBudgetCheck,
  awsBudgetUnset,
  bindingCheck,
  failed,
  MERGE_GATE_CHECKS,
  decodeOverlay,
  placeholderOverlay,
  profileCheck,
  readOnlyScanCheck,
  rulesetCheck,
  scopedIdentityCheck,
  settingsDrift,
  type AwsBudget,
  type AwsBudgetAction,
  type AwsPolicyStatement,
  type DeployedSettings,
} from "./index.ts";
import { validationContext } from "@fractalboxdev/flare-dispatch-profile";

const settings: DeployedSettings = {
  bindings: [
    { name: "DB", type: "d1", target: "db-id" },
    { name: "CHANNEL", type: "durable_object_namespace", target: "ExecutorChannel" },
  ],
  vars: { DEPLOYMENT: "production" },
  secrets: ["GITHUB_APP_PRIVATE_KEY"],
  crons: ["* * * * *"],
  routes: ["dispatch.example.com"],
  compatibility_date: "2026-05-01",
  compatibility_flags: [],
  containers: [{ class_name: "LeanPool", max_instances: 64, image: "sha256:abc" }],
};

const containers = (max: Record<string, number>) => ({
  containers: Object.entries(max).map(([pool, n]) => ({
    class_name: `${pool.charAt(0).toUpperCase()}${pool.slice(1)}Pool`,
    max_instances: n,
  })),
});

describe("drift check", () => {
  it("[FD-OPS-016] [FD-OPS-017] each deployed setting that differs from the record fails with both values", () => {
    expect(settingsDrift("cp", settings, settings)).toEqual([]);
    const deployed: DeployedSettings = {
      ...settings,
      vars: { DEPLOYMENT: "development" },
      crons: ["*/5 * * * *"],
      containers: [{ class_name: "LeanPool", max_instances: 32, image: "sha256:abc" }],
    };
    const findings = settingsDrift("cp", settings, deployed);
    expect(findings.map((f) => f.path)).toEqual([
      "cp.vars.DEPLOYMENT",
      "cp.crons",
      "cp.containers.LeanPool",
    ]);
    expect(findings[0]!.detail).toBe('deployed "development", recorded "production"');
  });

  it("[FD-OPS-017] a secret shows by name only, never a value", () => {
    const findings = settingsDrift("cp", settings, {
      ...settings,
      secrets: ["GITHUB_APP_PRIVATE_KEY", "LINK_KEY"],
    });
    expect(findings).toEqual([
      {
        check: "settings",
        path: "cp.secrets.LINK_KEY",
        detail: "secret LINK_KEY present on the deployed Worker, absent in the record",
        severity: "failure",
      },
    ]);
  });

  it("[FD-OPS-019] a binding the environment schema declares and the rendered configuration lacks fails, named", () => {
    const rendered = {
      d1_databases: [{ binding: "DB" }],
      durable_objects: { bindings: [{ name: "CHANNEL" }] },
      vars: { PLANE_ID: "x" },
    };
    expect(bindingCheck("cp", rendered, ["DB", "CHANNEL", "PLANE_ID"])).toEqual([]);
    expect(bindingCheck("cp", rendered, ["DB", "MONITOR"]).map((f) => f.path)).toEqual([
      "cp.MONITOR",
    ]);
  });

  it("[FD-OPS-020] [FD-PROF-033] a pool whose admission cap is not below its Container class's max_instances fails", () => {
    const ok = containers({ lean: 49, agent: 9, browser: 17, release: 9, control: 17 });
    expect(admissionCapCheck("cp", ok)).toEqual([]);
    const equal = containers({ lean: 48, agent: 9, browser: 17, release: 9, control: 17 });
    expect(admissionCapCheck("cp", equal).map((f) => f.path)).toEqual([
      "cp.containers.LeanPool.max_instances",
    ]);
    expect(admissionCapCheck("cp", {}).map((f) => f.detail)).toContain(
      "pool lean has no Container class LeanPool",
    );
  });

  it("[FD-OPS-021] mameko's profile validator rejections fail the check, every one listed", () => {
    expect(
      Effect.runSync(profileCheck(profileDocumentFor("production"), validationContext)),
    ).toEqual([]);
    const doc = profileDocumentFor("production");
    const broken = {
      ...doc,
      document: {
        ...(doc.document as object),
        gate_policy: { keys: ["x"], max_expiry_seconds: 0 },
      },
    };
    const findings = Effect.runSync(profileCheck(broken, validationContext));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.check === "profile")).toBe(true);
  });

  it("[FD-OPS-022] a registration lacking a permission, at a lower level, or lacking a manifest event fails", () => {
    expect(appRegistrationCheck(APP_PERMISSIONS, APP_PERMISSIONS)).toEqual([]);
    const noAdmin = Object.fromEntries(
      Object.entries(APP_PERMISSIONS.default_permissions)
        .filter(([p]) => p !== "administration")
        .map(([p, level]) => [p, p === "checks" ? ("read" as const) : level]),
    );
    const findings = appRegistrationCheck(APP_PERMISSIONS, {
      default_permissions: noAdmin,
      default_events: APP_PERMISSIONS.default_events.filter((e) => e !== "merge_group"),
    });
    expect(findings.map((f) => f.path)).toEqual([
      "permissions.checks",
      "permissions.administration",
      "events.merge_group",
    ]);
    expect(failed(findings)).toBe(true);
  });

  it("[FD-OPS-023] an extra subscribed event warns and does not fail the check", () => {
    const extra = {
      ...APP_PERMISSIONS,
      default_events: [...APP_PERMISSIONS.default_events, "star"],
    };
    const findings = appRegistrationCheck(APP_PERMISSIONS, extra);
    expect(findings).toEqual([
      expect.objectContaining({ path: "events.star", severity: "warning" }),
    ]);
    expect(failed(findings)).toBe(false);
  });

  it("[FD-VER-023] [FD-OPS-028] the drift check fails when the ruleset lacks a merge-gate check", () => {
    expect(rulesetCheck([...MERGE_GATE_CHECKS, "flare-dispatch/check:ci"])).toEqual([]);
    expect(
      rulesetCheck(MERGE_GATE_CHECKS.filter((c) => c !== "formal")).map((f) => f.path),
    ).toEqual(["required_status_checks.formal", "required_status_checks.flare-dispatch/check:ci"]);
  });

  it("[FD-OPS-029] the App asks administration at read, below the write a ruleset change needs", () => {
    // GitHub refuses a ruleset create, update or delete to an installation without `administration: write`.
    for (const { default_permissions } of [APP_PERMISSIONS, appManifest("https://cp.example")]) {
      expect(default_permissions.administration).toBe("read");
      expect(Object.values(default_permissions)).not.toContain("admin");
    }
  });
});

const ACCOUNT = "111122223333";
const budget: AwsBudget = {
  name: "fd-aws",
  type: "COST",
  limitAmount: 400,
  limitUnit: "USD",
  timeUnit: "MONTHLY",
  timePeriod: { Start: Date.UTC(2026, 0, 1) / 1000, End: Date.UTC(2087, 5, 15) / 1000 },
  costFilters: {},
};
const budgets = [budget];
const DENY_LAUNCH: AwsPolicyStatement = {
  effect: "Deny",
  actions: ["ecs:RunTask", "ecs:StartTask"],
  resources: ["*"],
  conditional: false,
};
const denyAction = (over: Partial<AwsBudgetAction> = {}): AwsBudgetAction => ({
  id: "act-1",
  budgetName: "fd-aws",
  status: "STANDBY",
  notificationType: "ACTUAL",
  actionType: "APPLY_IAM_POLICY",
  approvalModel: "AUTOMATIC",
  thresholdType: "PERCENTAGE",
  thresholdValue: 100,
  policy: {
    id: `arn:aws:iam::${ACCOUNT}:policy/fd-deny-launch`,
    targets: ["fd-launcher"],
    roles: ["fd-launcher"],
    statements: [DENY_LAUNCH],
  },
  ...over,
});
const scpAction = (targets: string[], statements: AwsPolicyStatement[] = [DENY_LAUNCH]) =>
  denyAction({
    actionType: "APPLY_SCP_POLICY",
    policy: { id: "p-deny", targets, statements, policyType: "SERVICE_CONTROL_POLICY" },
  });
const withStatements = (...statements: AwsPolicyStatement[]) =>
  denyAction({ policy: { ...denyAction().policy!, statements } });
const check = (limitUsd: number, actions: AwsBudgetAction[], read = budgets) =>
  awsBudgetCheck(
    limitUsd,
    {
      account: ACCOUNT,
      observedAt: Date.UTC(2026, 10, 1),
      budgets: read,
      actions,
      organization: {
        managementAccount: "999900001111",
        scpEnabled: true,
        ancestors: ["ou-abcd-11111111", "r-abcd"],
      },
    },
    `arn:aws:iam::${ACCOUNT}:role/fd-launcher`,
  );
/** The reason the one action read falls short, from the check's failure line. */
const gapOf = (actions: AwsBudgetAction[], read = budgets) =>
  check(400, actions, read)[0]?.detail.split(": ").slice(1).join(": ");

describe("AWS budget check", () => {
  it("[FD-EXEC-083] passes on a Budgets action that applies a deny-launch policy without approval once actual spend reaches the AWS limit", () => {
    expect(check(400, [denyAction()])).toEqual([]);
    expect(check(400, [scpAction([ACCOUNT])])).toEqual([]);
    expect(check(400, [scpAction(["r-abcd"])])).toEqual([]);
    expect(
      check(400, [denyAction({ thresholdType: "ABSOLUTE_VALUE", thresholdValue: 400 })]),
    ).toEqual([]);
    // 100% of a 400 USD budget runs above a 300 USD limit; 75% of it runs at the limit.
    expect(failed(check(300, [denyAction()]))).toBe(true);
    expect(check(300, [denyAction({ thresholdValue: 75 })])).toEqual([]);
    // `ecs:*` and `*` cover both launch calls, as do two statements that each deny one; action names ignore case.
    for (const statements of [
      [{ ...DENY_LAUNCH, actions: ["ecs:*"] }],
      [{ ...DENY_LAUNCH, actions: ["*"] }],
      [
        { ...DENY_LAUNCH, actions: ["ECS:runtask"] },
        { ...DENY_LAUNCH, actions: ["ecs:Start*"] },
      ],
    ])
      expect(check(400, [withStatements(...statements)])).toEqual([]);
    // A budget that resets monthly or less often, unfiltered or filtered to the ECS service, measures the AWS spend.
    for (const measured of [
      { timeUnit: "QUARTERLY" },
      {
        costFilters: {
          Service: ["Amazon Elastic Container Service", "Amazon EC2 Container Registry (ECR)"],
        },
      },
    ])
      expect(check(400, [denyAction()], [{ ...budget, ...measured }])).toEqual([]);
  });

  it("[FD-EXEC-083] fails when the account carries no Budgets action, or none that qualifies", () => {
    expect(check(400, [])).toEqual([
      {
        check: "aws-budget",
        path: "aws.budgetAction",
        detail:
          "AWS account 111122223333 carries no Budgets action that denies new task launches when actual spend reaches aws.budgetUsd 400 USD: it carries no Budgets action",
        severity: "failure",
      },
    ]);
    for (const over of [
      { notificationType: "FORECASTED" },
      { actionType: "RUN_SSM_DOCUMENTS", policy: null },
      { approvalModel: "MANUAL" },
      { thresholdValue: 101 },
      { budgetName: "other" },
      { policy: null },
    ]) {
      const findings = check(400, [denyAction(over)]);
      expect(findings.map((f) => [f.path, f.severity])).toEqual([["aws.budgetAction", "failure"]]);
    }
    expect(
      check(400, [denyAction()], [{ ...budget, limitUnit: "EUR" }]).map((f) => f.path),
    ).toEqual(["aws.budgetAction"]);
  });

  it("[FD-EXEC-083] fails on an action whose policy does not deny both launch calls on every resource, unconditionally", () => {
    const denies = (statement: Partial<AwsPolicyStatement>) =>
      withStatements({ ...DENY_LAUNCH, ...statement });
    const line = `action act-1 applies policy arn:aws:iam::${ACCOUNT}:policy/fd-deny-launch, which does not deny ecs:RunTask and ecs:StartTask on every resource under no condition`;
    for (const action of [
      denies({ actions: ["s3:PutObject"] }),
      denies({ actions: ["ecs:RunTask"] }),
      denies({ effect: "Allow" }),
      denies({ resources: [`arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/web:*`] }),
      denies({ conditional: true }),
      // A `NotAction` statement reads as no `Action` patterns.
      denies({ actions: [] }),
      withStatements(),
    ])
      expect(gapOf([action])).toBe(line);
  });

  it("[FD-EXEC-083] fails on an action whose policy misses the launcher role, or an SCP outside the account's ancestry", () => {
    expect(
      gapOf([denyAction({ policy: { ...denyAction().policy!, targets: [], roles: [] } })]),
    ).toBe(
      `action act-1 attaches policy arn:aws:iam::${ACCOUNT}:policy/fd-deny-launch to no launcher role arn:aws:iam::${ACCOUNT}:role/fd-launcher`,
    );
    for (const targets of [[], ["444455556666"], ["ou-abcd-22222222"], ["r-other"]])
      expect(gapOf([scpAction(targets)])).toBe(
        `action act-1 attaches policy p-deny to neither account ${ACCOUNT} nor one of its organization ancestors`,
      );
    expect(check(400, [scpAction(["ou-abcd-11111111"])])).toEqual([]);
  });

  it("[FD-EXEC-083] requires an authenticated-account launcher role and never substitutes same-named users or groups", () => {
    const read = {
      account: ACCOUNT,
      observedAt: Date.UTC(2026, 10, 1),
      budgets,
      actions: [denyAction()],
    };
    for (const role of [undefined, "not-an-arn", "arn:aws:iam::444455556666:role/fd-launcher"])
      expect(failed(awsBudgetCheck(400, read, role))).toBe(true);
    expect(awsBudgetCheck(400, read, `arn:aws:iam::${ACCOUNT}:role/path/fd-launcher`)).toEqual([]);
    expect(
      awsBudgetCheck(
        400,
        {
          ...read,
          actions: [
            denyAction({ policy: { ...denyAction().policy!, roles: ["path/fd-launcher"] } }),
          ],
        },
        `arn:aws:iam::${ACCOUNT}:role/path/fd-launcher`,
      ),
    ).toEqual([]);
    for (const roles of [[], ["unrelated-role"], undefined])
      expect(
        failed(
          check(400, [
            denyAction({
              policy: {
                ...denyAction().policy!,
                targets: ["fd-launcher"],
                roles,
              },
            }),
          ]),
        ),
      ).toBe(true);
  });

  it("[FD-EXEC-083] never claims an SCP constrains the management account or an account whose membership was not read", () => {
    const read = {
      account: ACCOUNT,
      observedAt: Date.UTC(2026, 10, 1),
      budgets,
      actions: [scpAction(["r-abcd"])],
    };
    expect(failed(awsBudgetCheck(400, read))).toBe(true);
    expect(
      failed(
        awsBudgetCheck(400, {
          ...read,
          organization: { managementAccount: ACCOUNT, ancestors: ["r-abcd"], scpEnabled: true },
        }),
      ),
    ).toBe(true);
  });

  it("[FD-EXEC-083] requires an actual SCP and an enabled root SCP policy type", () => {
    const action = scpAction([ACCOUNT]);
    const read = {
      account: ACCOUNT,
      observedAt: Date.UTC(2026, 10, 1),
      budgets,
      actions: [action],
      organization: {
        managementAccount: "999900001111",
        ancestors: ["r-abcd"],
        scpEnabled: true,
      },
    };
    expect(
      failed(
        awsBudgetCheck(400, { ...read, organization: { ...read.organization, scpEnabled: false } }),
      ),
    ).toBe(true);
    for (const policyType of [undefined, "TAG_POLICY"])
      expect(
        failed(
          awsBudgetCheck(400, {
            ...read,
            actions: [{ ...action, policy: { ...action.policy!, policyType } }],
          }),
        ),
      ).toBe(true);
  });

  it("[FD-EXEC-083] fails closed on malformed spend thresholds, amounts and periods", () => {
    for (const thresholdValue of [Number.NaN, Number.POSITIVE_INFINITY, -1])
      expect(failed(check(400, [denyAction({ thresholdValue })]))).toBe(true);
    expect(failed(check(400, [denyAction({ thresholdType: "" })]))).toBe(true);
    for (const bad of [{ limitAmount: Number.NaN }, { limitAmount: -1 }, { timeUnit: "" }])
      expect(failed(check(400, [denyAction()], [{ ...budget, ...bad }]))).toBe(true);
  });

  it("[FD-EXEC-083] requires an active action and proves modern filter coverage without dropping unknown scope", () => {
    expect(check(400, [denyAction({ status: "EXECUTION_SUCCESS" })])).toEqual([]);
    for (const status of ["", "EXECUTION_FAILURE", "REVERSE_SUCCESS", "PENDING", "unknown"])
      expect(failed(check(400, [denyAction({ status })]))).toBe(true);
    const ecs = { Dimensions: { Key: "SERVICE", Values: ["Amazon Elastic Container Service"] } };
    const region = { Dimensions: { Key: "REGION", Values: ["us-east-1"] } };
    for (const filterExpression of [{}, ecs, { And: [ecs, ecs] }, { Or: [region, ecs] }])
      expect(check(400, [denyAction()], [{ ...budget, filterExpression }])).toEqual([]);
    for (const filterExpression of [
      region,
      { And: [ecs, region] },
      { Not: ecs },
      { Or: [region] },
      { Or: [] },
      { Dimensions: { ...ecs.Dimensions, MatchOptions: ["ABSENT"] } },
      { Dimensions: { ...ecs.Dimensions, MatchOptions: ["unknown"] } },
      { Dimensions: { Key: "SERVICE", Values: "Amazon Elastic Container Service" } },
      { Dimensions: ecs.Dimensions, Tags: { Key: "team", Values: ["a"] } },
      null,
    ])
      expect(failed(check(400, [denyAction()], [{ ...budget, filterExpression }]))).toBe(true);
    expect(
      failed(
        check(
          400,
          [denyAction()],
          [{ ...budget, billingViewArn: "arn:aws:billing::111122223333:billingview/restricted" }],
        ),
      ),
    ).toBe(true);
    expect(failed(check(400, [denyAction()], [{ ...budget, costFilters: { Region: [] } }]))).toBe(
      true,
    );
  });

  it("[FD-EXEC-083] proves the budget is active at the read time, including exact window boundaries", () => {
    const start = Date.UTC(2026, 10, 1) / 1000;
    const end = start + 3600;
    const read = {
      account: ACCOUNT,
      observedAt: start * 1000,
      budgets: [{ ...budget, timePeriod: { Start: start, End: end } }],
      actions: [denyAction()],
    };
    const role = `arn:aws:iam::${ACCOUNT}:role/fd-launcher`;
    expect(awsBudgetCheck(400, read, role)).toEqual([]);
    expect(failed(awsBudgetCheck(400, { ...read, observedAt: start * 1000 - 1 }, role))).toBe(true);
    expect(failed(awsBudgetCheck(400, { ...read, observedAt: end * 1000 }, role))).toBe(true);
    for (const timePeriod of [
      undefined,
      {},
      null,
      { Start: start },
      { End: end },
      { Start: "unknown" },
      { End: Number.NaN },
      { Start: end, End: start },
      { start },
    ])
      expect(failed(check(400, [denyAction()], [{ ...budget, timePeriod }]))).toBe(true);
    const scpRead = {
      ...read,
      actions: [scpAction([ACCOUNT])],
      organization: {
        managementAccount: "999900001111",
        ancestors: ["r-abcd"],
        scpEnabled: true,
      },
    };
    expect(awsBudgetCheck(400, scpRead)).toEqual([]);
    expect(failed(awsBudgetCheck(400, scpRead, "arn:aws:iam::444455556666:role/fd-launcher"))).toBe(
      true,
    );
  });

  it("[FD-EXEC-083] fails on an action whose budget resets daily, or whose cost filters measure less than the ECS spend", () => {
    expect(gapOf([denyAction()], [{ ...budget, timeUnit: "DAILY" }])).toBe(
      "action act-1 belongs to budget fd-aws, which resets daily and lets a month's spend run past its limit",
    );
    expect(
      gapOf(
        [denyAction()],
        [{ ...budget, costFilters: { Service: ["Amazon Simple Storage Service"] } }],
      ),
    ).toBe(
      "action act-1 belongs to budget fd-aws, whose Service cost filter leaves out Amazon Elastic Container Service",
    );
    expect(
      gapOf(
        [denyAction()],
        [
          {
            ...budget,
            costFilters: { Service: ["Amazon Elastic Container Service"], Region: ["eu-west-1"] },
          },
        ],
      ),
    ).toBe(
      "action act-1 belongs to budget fd-aws, whose Region cost filter measures only part of the account's spend",
    );
  });

  it("[FD-EXEC-083] a deploy that sets no aws.budgetUsd fails on the overlay", () => {
    expect(awsBudgetUnset).toEqual({
      check: "aws-budget",
      path: "aws.budgetUsd",
      detail:
        "the overlay carries the aws kind and sets no AWS limit for the Budgets action to enforce",
      severity: "failure",
    });
  });
});

/** A read-only scan declaration: commit inputs only, no model call site, only `check.*` intent kinds. */
const ScanInput = Schema.Struct({
  repo: Schema.String,
  sha: Schema.String,
  baseRef: Schema.optionalKey(Schema.String),
});
const scan: RunDeclaration = {
  spec: { needsModel: false, intentKinds: ["check.open", "check.conclude"], readOnlyScan: true },
  input: ScanInput,
};
const withCommand: RunDeclaration = {
  ...scan,
  input: Schema.Struct({
    ...ScanInput.fields,
    steps: Schema.Array(Schema.Struct({ label: Schema.String, command: Schema.String })),
  }),
};
const withCallSite: RunDeclaration = {
  ...scan,
  agentic: {
    declaration: { callSites: [{ name: "reviewer" }], intentKinds: ["check.open"] },
  },
};
const withModel: RunDeclaration = { ...scan, spec: { ...scan.spec, needsModel: true } };
const withKind: RunDeclaration = {
  ...scan,
  spec: { ...scan.spec, intentKinds: ["check.open", "dispatch.followOn"] },
};
const notReadOnly = (d: RunDeclaration): RunDeclaration => {
  const { readOnlyScan: _r, ...spec } = d.spec;
  return { ...d, spec };
};

describe("the registry validator over read-only scan declarations", () => {
  it("[FD-GATE-113] rejects a readOnlyScan declaration holding a command input, a model call site or a non-check.* intent kind, naming the run", () => {
    expect(readOnlyScanCheck(RUN_CATALOG)).toEqual([]);
    expect(readOnlyScanCheck({ "security-rescan": scan })).toEqual([]);

    const rejected = (d: RunDeclaration) =>
      readOnlyScanCheck({ "security-rescan": d }).map((f) => [
        f.check,
        f.path,
        f.detail,
        f.severity,
      ]);
    const at = ["read-only-scan", "runs.security-rescan.readOnlyScan"] as const;
    expect(rejected(withCommand)).toEqual([
      [...at, "readOnlyScan: command input steps[].command", "failure"],
    ]);
    expect(rejected(withCallSite)).toEqual([
      [...at, "readOnlyScan: model call site reviewer", "failure"],
    ]);
    expect(rejected(withModel)).toEqual([[...at, "readOnlyScan: needsModel", "failure"]]);
    expect(rejected(withKind)).toEqual([
      [...at, "readOnlyScan: intent kind dispatch.followOn", "failure"],
    ]);

    // The catalogue's own command-taking and model-calling runs, declared read-only, are each rejected.
    const check = {
      ...RUN_CATALOG["check"]!,
      spec: { ...RUN_CATALOG["check"]!.spec, readOnlyScan: true },
    };
    expect(readOnlyScanCheck({ check }).map((f) => f.detail)).toEqual([
      "readOnlyScan: command input steps[].command",
    ]);
    const review = RUN_CATALOG["pr-review"]!;
    expect(
      readOnlyScanCheck({
        "pr-review": { ...review, spec: { ...review.spec, readOnlyScan: true } },
      }).map((f) => f.detail),
    ).toEqual(
      expect.arrayContaining(
        AGENTIC_CATALOG["pr-review"]!.declaration.callSites.map(
          (c) => `readOnlyScan: model call site ${c.name}`,
        ),
      ),
    );

    // The rule binds only a declaration that sets readOnlyScan.
    for (const d of [withCommand, withCallSite, withModel, withKind])
      expect(readOnlyScanCheck({ run: notReadOnly(d) })).toEqual([]);
    expect([
      ...readOnlyScanRunsOf({
        "security-rescan": scan,
        bad: withCommand,
        check: notReadOnly(scan),
      }),
    ]).toEqual(["security-rescan"]);
  });
});

const SCAN_RUNS: ReadonlySet<string> = new Set(["security-rescan"]);
const scopedEntry = (identity: string, over: Record<string, unknown> = {}) => ({
  identity,
  runs: ["security-rescan"],
  repositories: ["acme/app"],
  classCeiling: "batch",
  ...over,
});
const identities = {
  operators: ["operator@example.com"],
  dispatchers: ["dispatcher@example.com"],
  containment: ["responder@example.com"],
};
const scopedFindings = (scoped: readonly ReturnType<typeof scopedEntry>[], lists = identities) =>
  scopedIdentityCheck({ ...lists, dispatch: { scoped } }, SCAN_RUNS).map((f) => [
    f.check,
    f.path,
    f.detail,
  ]);

describe("the drift check over the overlay's scoped and containment identities", () => {
  it("[FD-OPS-090] fails a dispatch.scoped identity that is also in dispatchers, operators or containment, naming the identity", () => {
    const overlay = Effect.runSync(
      decodeOverlay(
        JSON.stringify({
          ...placeholderOverlay,
          ...identities,
          dispatch: { scoped: [scopedEntry("scanner@example.com")] },
        }),
      ),
    );
    expect(scopedIdentityCheck(overlay, SCAN_RUNS)).toEqual([]);

    for (const [list, identity] of [
      ["dispatchers", "dispatcher@example.com"],
      ["operators", "Operator@Example.com"],
      ["containment", "responder@example.com"],
    ] as const)
      expect(scopedFindings([scopedEntry(identity)])).toEqual([
        ["scoped-identity", "dispatch.scoped.0.identity", `${identity} is also in ${list}`],
      ]);
  });

  it("[FD-OPS-091] fails a dispatch.scoped entry that names a run that is not a read-only scan run, naming the run", () => {
    expect(scopedFindings([scopedEntry("scanner@example.com")])).toEqual([]);
    expect(
      scopedFindings([
        scopedEntry("scanner@example.com", { runs: ["security-rescan", "check", "pr-review"] }),
      ]),
    ).toEqual([
      ["scoped-identity", "dispatch.scoped.0.runs", "run check is not a read-only scan run"],
      ["scoped-identity", "dispatch.scoped.0.runs", "run pr-review is not a read-only scan run"],
    ]);
    // With no read-only scan run in the catalogue, every scoped run fails.
    expect(
      scopedIdentityCheck(
        { ...identities, dispatch: { scoped: [scopedEntry("scanner@example.com")] } },
        new Set(),
      ).map((f) => f.detail),
    ).toEqual(["run security-rescan is not a read-only scan run"]);
  });

  it("[FD-OPS-092] fails a dispatch.scoped entry whose classCeiling is neither interactive nor batch, naming the identity", () => {
    for (const ceiling of ["interactive", "batch"])
      expect(
        scopedFindings([scopedEntry("scanner@example.com", { classCeiling: ceiling })]),
      ).toEqual([]);
    for (const ceiling of ["required", "release", "Batch"])
      expect(
        scopedFindings([scopedEntry("scanner@example.com", { classCeiling: ceiling })]),
      ).toEqual([
        [
          "scoped-identity",
          "dispatch.scoped.0.classCeiling",
          `scanner@example.com: classCeiling ${ceiling} is neither interactive nor batch`,
        ],
      ]);
  });

  it("[FD-OPS-093] fails a containment identity that is also in operators or dispatchers, naming the identity", () => {
    expect(scopedFindings([])).toEqual([]);
    expect(
      scopedFindings([], {
        ...identities,
        containment: ["responder@example.com", "operator@example.com", " DISPATCHER@example.com"],
      }),
    ).toEqual([
      ["containment-identity", "containment.1", "operator@example.com is also in operators"],
      ["containment-identity", "containment.2", " DISPATCHER@example.com is also in dispatchers"],
    ]);
  });
});
