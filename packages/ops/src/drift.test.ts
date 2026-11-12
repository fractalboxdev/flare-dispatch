import { profileDocumentFor } from "@fractalboxdev/flare-dispatch-profile";
import { Effect } from "effect";
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
  profileCheck,
  rulesetCheck,
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
    const read = { account: ACCOUNT, budgets, actions: [denyAction()] };
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
    const read = { account: ACCOUNT, budgets, actions: [scpAction(["r-abcd"])] };
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
