// The deploy suite of `V-DEPLOY` for the AWS budget check (specs/executors.md § AWS budget check): `fd deploy` and
// `fd doctor` on the fakes of `support.ts`, whose AWS endpoints answer only SigV4-signed requests for one account.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { placeholderOverlay, type OverlayValues } from "../../src/index.ts";
import { AWS_ACCOUNT, deploy, fd, isWrite, SCRIPT, world, type World } from "./support.ts";

const LIMIT_USD = 500;
const LAUNCHER = `arn:aws:iam::${AWS_ACCOUNT}:role/fd-launcher`;

const overlayWith = (aws: OverlayValues["aws"]) => JSON.stringify({ ...placeholderOverlay, aws });
const AWS_OVERLAY = overlayWith({ budgetUsd: LIMIT_USD, launchCap: 4, launcherRoleArn: LAUNCHER });

/** The USD cost budget the AWS kind's launches spend against, at the overlay's limit. */
const BUDGET = {
  BudgetName: "fd-aws",
  BudgetType: "COST",
  TimeUnit: "MONTHLY",
  TimePeriod: { Start: Date.UTC(2026, 0, 1) / 1000, End: Date.UTC(2087, 5, 15) / 1000 },
  BudgetLimit: { Amount: "500.0", Unit: "USD" },
};

/** A policy document that denies every ECS call on every resource. */
const DENY_ECS = {
  Version: "2012-10-17",
  Statement: [{ Effect: "Deny", Action: ["ecs:*"], Resource: "*" }],
};

/** The account's policies: the deny-launch SCP and IAM policy, and an IAM policy that denies only S3 writes. */
const POLICIES = {
  "p-denyrunt": DENY_ECS,
  [`arn:aws:iam::${AWS_ACCOUNT}:policy/fd-deny-launch`]: {
    Version: "2012-10-17",
    Statement: { Effect: "Deny", Action: ["ecs:RunTask", "ecs:StartTask"], Resource: ["*"] },
  },
  [`arn:aws:iam::${AWS_ACCOUNT}:policy/deny-s3-write`]: {
    Version: "2012-10-17",
    Statement: [{ Effect: "Deny", Action: "s3:PutObject", Resource: "*" }],
  },
};

/** An account whose budget sits at the overlay's limit and whose policies the actions name. */
const awsWorld = () => {
  const w = world();
  w.state.awsBudgets = [BUDGET];
  w.state.awsPolicies = POLICIES;
  return w;
};

/** An `APPLY_IAM_POLICY` definition: the policy, attached to the launcher's role unless `roles` says otherwise. */
const iamDefinition = (policy: string, roles: string[] = ["fd-launcher"]) => ({
  IamActionDefinition: { PolicyArn: `arn:aws:iam::${AWS_ACCOUNT}:policy/${policy}`, Roles: roles },
});

/** A Budgets action that applies a deny-launch SCP, with no approval, when actual spend reaches the budget's limit. */
const action = (id: string, over: Record<string, unknown> = {}) => ({
  ActionId: id,
  BudgetName: "fd-aws",
  NotificationType: "ACTUAL",
  ActionType: "APPLY_SCP_POLICY",
  ActionThreshold: { ActionThresholdValue: 100, ActionThresholdType: "PERCENTAGE" },
  Definition: { ScpActionDefinition: { PolicyId: "p-denyrunt", TargetIds: [AWS_ACCOUNT] } },
  ExecutionRoleArn: `arn:aws:iam::${AWS_ACCOUNT}:role/fd-budget-action`,
  ApprovalModel: "AUTOMATIC",
  Status: "STANDBY",
  Subscribers: [],
  ...over,
});

const awsCalls = (w: World) => w.calls.filter((c) => /amazonaws\.com/.test(c));

const driftStage = (report: {
  readonly stages: readonly { stage: string; ok: boolean; detail: string }[];
}) => report.stages.find((s) => s.stage === "drift");

const doctor = (w: World, overlay = AWS_OVERLAY) => Effect.runPromise(fd(w).doctor(overlay));

const missing = (why: string) =>
  `aws.budgetAction: AWS account ${AWS_ACCOUNT} carries no Budgets action that denies new task launches when actual spend reaches aws.budgetUsd ${LIMIT_USD} USD: ${why}`;

describe("the AWS budget check of the drift check", () => {
  it("[FD-EXEC-083] fd doctor reads the AWS account's Budgets actions where the overlay carries the aws kind, and passes when one denies new launches at aws.budgetUsd", async () => {
    const w = awsWorld();
    // The qualifying action sits on the second page: the read follows `NextToken`.
    w.state.awsActions = [
      action("act-ssm", { ActionType: "RUN_SSM_DOCUMENTS" }),
      action("act-deny"),
    ];
    const report = await doctor(w);
    expect(report.ok).toBe(true);
    expect(driftStage(report)).toEqual({ stage: "drift", ok: true, detail: "" });
    expect(awsCalls(w)).toEqual([
      "POST sts.amazonaws.com/",
      "POST budgets.amazonaws.com/",
      "POST budgets.amazonaws.com/",
      "POST budgets.amazonaws.com/",
      // Prove the deploying account is affected by this SCP, then read its policy document.
      "POST organizations.us-east-1.amazonaws.com/",
      "POST organizations.us-east-1.amazonaws.com/",
      "POST organizations.us-east-1.amazonaws.com/",
      // The SCP's content; the SSM action applies no policy, so nothing reads one for it.
      "POST organizations.us-east-1.amazonaws.com/",
    ]);
    expect(w.calls.filter(isWrite)).toEqual([]);

    // An absolute threshold at the limit qualifies, and so does one that denies launches before spend reaches it.
    for (const threshold of [
      { ActionThresholdValue: LIMIT_USD, ActionThresholdType: "ABSOLUTE_VALUE" },
      { ActionThresholdValue: 80, ActionThresholdType: "PERCENTAGE" },
    ]) {
      const at = awsWorld();
      at.state.awsActions = [action("act-deny", { ActionThreshold: threshold })];
      expect((await doctor(at)).ok).toBe(true);
    }

    // An IAM policy that denies both launch calls to the launcher's role qualifies, read as its default version.
    const iam = awsWorld();
    iam.state.awsActions = [
      action("act-iam", {
        ActionType: "APPLY_IAM_POLICY",
        Definition: iamDefinition("fd-deny-launch"),
      }),
    ];
    expect((await doctor(iam)).ok).toBe(true);
    expect(awsCalls(iam).slice(-2)).toEqual(["POST iam.amazonaws.com/", "POST iam.amazonaws.com/"]);

    // So does an SCP on the organization root, and a budget filtered to the ECS service.
    const root = awsWorld();
    root.state.awsBudgets = [
      { ...BUDGET, CostFilters: { Service: ["Amazon Elastic Container Service"] } },
    ];
    root.state.awsActions = [
      action("act-root", {
        Definition: { ScpActionDefinition: { PolicyId: "p-denyrunt", TargetIds: ["r-abcd"] } },
      }),
    ];
    expect((await doctor(root)).ok).toBe(true);

    // A deploy whose overlay carries no aws kind reads nothing from AWS.
    const none = world();
    expect((await doctor(none, JSON.stringify(placeholderOverlay))).ok).toBe(true);
    expect(awsCalls(none)).toEqual([]);
  });

  it("[FD-EXEC-083] fd deploy and fd doctor fail the drift check when the AWS account carries no Budgets action, before any Cloudflare write", async () => {
    const w = awsWorld();
    const line = missing("it carries no Budgets action");

    const report = await deploy(w, AWS_OVERLAY);
    expect(report.ok).toBe(false);
    expect(report.stages.at(-1)).toEqual({ stage: "drift", ok: false, detail: line });
    expect(w.calls.filter(isWrite)).toEqual([]);
    expect(w.calls).not.toContain(`wrangler deploy ${SCRIPT}`);

    const checked = await doctor(w);
    expect(checked.ok).toBe(false);
    expect(driftStage(checked)).toEqual({ stage: "drift", ok: false, detail: `failure ${line}` });

    // Once the account carries the action, the same deploy goes out.
    w.state.awsActions = [action("act-deny")];
    expect((await deploy(w, AWS_OVERLAY)).ok).toBe(true);
    expect(w.calls).toContain(`wrangler deploy ${SCRIPT}`);
  });

  it("[FD-EXEC-083] fails when no action denies launches on actual spend at the limit, listing why each action falls short", async () => {
    const w = awsWorld();
    w.state.awsBudgets = [
      BUDGET,
      {
        ...BUDGET,
        BudgetName: "usage",
        BudgetType: "USAGE",
        BudgetLimit: { Amount: "10", Unit: "GB" },
      },
      { ...BUDGET, BudgetName: "daily", TimeUnit: "DAILY" },
      {
        ...BUDGET,
        BudgetName: "s3-only",
        CostFilters: { Service: ["Amazon Simple Storage Service"] },
      },
      { ...BUDGET, BudgetName: "tagged", CostFilters: { TagKeyValue: ["user:team$web"] } },
    ];
    w.state.awsActions = [
      action("act-forecast", { NotificationType: "FORECASTED" }),
      action("act-ssm", { ActionType: "RUN_SSM_DOCUMENTS" }),
      action("act-manual", { ApprovalModel: "MANUAL" }),
      action("act-above", {
        ActionThreshold: { ActionThresholdValue: 120, ActionThresholdType: "PERCENTAGE" },
      }),
      action("act-usage", { BudgetName: "usage" }),
      action("act-gone", { BudgetName: "deleted" }),
      action("act-daily", { BudgetName: "daily" }),
      action("act-s3", { BudgetName: "s3-only" }),
      action("act-tagged", { BudgetName: "tagged" }),
      action("act-s3-deny", {
        ActionType: "APPLY_IAM_POLICY",
        Definition: iamDefinition("deny-s3-write"),
      }),
      action("act-no-role", {
        ActionType: "APPLY_IAM_POLICY",
        Definition: iamDefinition("fd-deny-launch", []),
      }),
      action("act-other-account", {
        Definition: {
          ScpActionDefinition: { PolicyId: "p-denyrunt", TargetIds: ["444455556666"] },
        },
      }),
    ];
    const report = await doctor(w);
    expect(report.ok).toBe(false);
    expect(driftStage(report)).toEqual({
      stage: "drift",
      ok: false,
      detail: `failure ${missing(
        [
          "action act-forecast runs on forecast spend, not actual spend",
          "action act-ssm is RUN_SSM_DOCUMENTS, which applies no deny policy",
          "action act-manual waits for manual approval",
          `action act-above runs at 600 USD, above aws.budgetUsd ${LIMIT_USD} USD`,
          "action act-usage belongs to budget usage, which is not a USD cost budget",
          "action act-gone names budget deleted, which the account lacks",
          "action act-daily belongs to budget daily, which resets daily and lets a month's spend run past its limit",
          "action act-s3 belongs to budget s3-only, whose Service cost filter leaves out Amazon Elastic Container Service",
          "action act-tagged belongs to budget tagged, whose TagKeyValue cost filter measures only part of the account's spend",
          `action act-s3-deny applies policy arn:aws:iam::${AWS_ACCOUNT}:policy/deny-s3-write, which does not deny ecs:RunTask and ecs:StartTask on every resource under no condition`,
          `action act-no-role attaches policy arn:aws:iam::${AWS_ACCOUNT}:policy/fd-deny-launch to no launcher role ${LAUNCHER}`,
          `action act-other-account attaches policy p-denyrunt to neither account ${AWS_ACCOUNT} nor one of its organization ancestors`,
        ].join("; "),
      )}`,
    });
  });

  it("[FD-EXEC-083] never treats a policy on an unrelated or same-named user/group as a launcher safeguard", async () => {
    for (const definition of [
      iamDefinition("fd-deny-launch", ["someone-else"]),
      {
        IamActionDefinition: {
          ...iamDefinition("fd-deny-launch").IamActionDefinition,
          Roles: [],
          Users: ["fd-launcher"],
          Groups: ["fd-launcher"],
        },
      },
    ]) {
      const w = awsWorld();
      w.state.awsActions = [
        action("act-iam", { ActionType: "APPLY_IAM_POLICY", Definition: definition }),
      ];
      expect((await doctor(w)).ok).toBe(false);
      expect(w.calls.filter(isWrite)).toEqual([]);
    }
    for (const launcherRoleArn of [undefined, "arn:aws:iam::444455556666:role/fd-launcher"]) {
      const w = awsWorld();
      w.state.awsActions = [
        action("act-iam", {
          ActionType: "APPLY_IAM_POLICY",
          Definition: iamDefinition("fd-deny-launch"),
        }),
      ];
      const report = await doctor(w, overlayWith({ budgetUsd: LIMIT_USD, launcherRoleArn }));
      expect(report.ok).toBe(false);
      expect(driftStage(report)?.detail).toContain(
        "cannot prove the IAM policy affects the launcher",
      );
    }
  });

  it("[FD-EXEC-083] proves SCP membership and refuses management accounts, unrelated roots and incomplete ancestry", async () => {
    const management = awsWorld();
    management.state.awsManagementAccount = AWS_ACCOUNT;
    management.state.awsActions = [action("act-deny")];
    expect(driftStage(await doctor(management))?.detail).toContain("SCPs do not affect it");

    const unrelated = awsWorld();
    unrelated.state.awsActions = [
      action("act-deny", {
        Definition: { ScpActionDefinition: { PolicyId: "p-denyrunt", TargetIds: ["r-other"] } },
      }),
    ];
    expect((await doctor(unrelated)).ok).toBe(false);

    const nested = awsWorld();
    nested.state.awsParents = {
      [AWS_ACCOUNT]: { Parents: [{ Id: "ou-abcd-11111111", Type: "ORGANIZATIONAL_UNIT" }] },
      "ou-abcd-11111111": { Parents: [{ Id: "r-abcd", Type: "ROOT" }] },
    };
    nested.state.awsActions = [
      action("act-deny", {
        Definition: {
          ScpActionDefinition: { PolicyId: "p-denyrunt", TargetIds: ["ou-abcd-11111111"] },
        },
      }),
    ];
    expect((await doctor(nested)).ok).toBe(true);

    for (const parents of [
      {},
      { [AWS_ACCOUNT]: { Parents: [], NextToken: "more" } },
      {
        [AWS_ACCOUNT]: { Parents: [{ Id: "ou-abcd-11111111", Type: "ORGANIZATIONAL_UNIT" }] },
        "ou-abcd-11111111": { Parents: [{ Id: "ou-abcd-11111111", Type: "ORGANIZATIONAL_UNIT" }] },
      },
      Object.fromEntries(
        Array.from({ length: 33 }, (_, n) => [
          n === 0 ? AWS_ACCOUNT : `ou-abcd-${n}`,
          { Parents: [{ Id: `ou-abcd-${n + 1}`, Type: "ORGANIZATIONAL_UNIT" }] },
        ]),
      ),
    ]) {
      const w = awsWorld();
      w.state.awsParents = parents;
      w.state.awsActions = [action("act-deny")];
      const report = await deploy(w, AWS_OVERLAY);
      expect(report.ok).toBe(false);
      expect(driftStage(report)?.detail).toContain("aws-organizations membership");
      expect(w.calls.filter(isWrite)).toEqual([]);
      expect(awsCalls(w).length).toBeLessThan(40);
    }
  });

  it("[FD-EXEC-083] refuses missing thresholds and unknown budget periods instead of treating them as zero spend", async () => {
    for (const change of [
      { ActionThreshold: {} },
      { ActionThreshold: { ActionThresholdType: "UNKNOWN", ActionThresholdValue: 0 } },
    ]) {
      const w = awsWorld();
      w.state.awsActions = [action("act-deny", change)];
      expect((await doctor(w)).ok).toBe(false);
    }
    for (const budget of [
      { ...BUDGET, TimeUnit: "" },
      { ...BUDGET, BudgetLimit: { Amount: "invalid", Unit: "USD" } },
    ]) {
      const w = awsWorld();
      w.state.awsBudgets = [budget];
      w.state.awsActions = [action("act-deny")];
      expect((await doctor(w)).ok).toBe(false);
    }
  });

  it("[FD-EXEC-083] requires the account root's SCP type enabled and the actual policy to be an SCP", async () => {
    const enabled = {
      Id: "r-abcd",
      PolicyTypes: [{ Type: "SERVICE_CONTROL_POLICY", Status: "ENABLED" }],
    };
    const paged = awsWorld();
    paged.state.awsRoots = [{ Id: "r-other", PolicyTypes: [] }, enabled];
    paged.state.awsActions = [action("act-deny")];
    expect((await doctor(paged)).ok).toBe(true);

    for (const PolicyTypes of [
      [],
      [{ Type: "SERVICE_CONTROL_POLICY", Status: "PENDING_ENABLE" }],
      [{ Type: "TAG_POLICY", Status: "ENABLED" }],
    ]) {
      const w = awsWorld();
      w.state.awsRoots = [{ Id: "r-abcd", PolicyTypes }];
      w.state.awsActions = [action("act-deny")];
      const report = await doctor(w);
      expect(report.ok).toBe(false);
      expect(driftStage(report)?.detail).toContain("no enabled SCP policy type");
    }
    for (const roots of [
      [],
      [{ Id: "r-other", PolicyTypes: [] }],
      [{ Id: "r-abcd" }],
      Array.from({ length: 33 }, (_, n) => ({ Id: `r-other${n}`, PolicyTypes: [] })),
    ]) {
      const w = awsWorld();
      w.state.awsRoots = roots;
      w.state.awsActions = [action("act-deny")];
      const report = await deploy(w, AWS_OVERLAY);
      expect(report.ok).toBe(false);
      expect(driftStage(report)?.detail).toContain("aws-organizations membership");
      expect(awsCalls(w).length).toBeLessThan(40);
      expect(w.calls.filter(isWrite)).toEqual([]);
    }
    const unreadable = awsWorld();
    unreadable.state.awsActions = [action("act-deny")];
    unreadable.state.awsRootsReadFails = true;
    expect(driftStage(await doctor(unreadable))?.detail).toContain(
      "aws-organizations ListRoots: 403",
    );

    const wrongType = awsWorld();
    wrongType.state.awsActions = [action("act-deny")];
    wrongType.state.awsPolicyTypes = { "p-denyrunt": "TAG_POLICY" };
    expect(driftStage(await doctor(wrongType))?.detail).toContain(
      "not a verified SERVICE_CONTROL_POLICY",
    );
  });

  it("[FD-EXEC-083] reads modern filter and billing-view scope and never projects restricted scope to an unfiltered budget", async () => {
    const ecs = {
      Dimensions: {
        Key: "SERVICE",
        Values: ["Amazon Elastic Container Service"],
        MatchOptions: ["EQUALS"],
      },
    };
    const region = { Dimensions: { Key: "REGION", Values: ["us-east-1"] } };
    for (const [scope, ok] of [
      [{ FilterExpression: ecs }, true],
      [{ FilterExpression: { And: [ecs, ecs] } }, true],
      [{ FilterExpression: { Or: [region, ecs] } }, true],
      [{ FilterExpression: region }, false],
      [{ FilterExpression: { And: [ecs, region] } }, false],
      [{ FilterExpression: { Not: ecs } }, false],
      [
        { FilterExpression: { Dimensions: { ...ecs.Dimensions, MatchOptions: ["ABSENT"] } } },
        false,
      ],
      [{ FilterExpression: null }, false],
      [{ BillingViewArn: `arn:aws:billing::${AWS_ACCOUNT}:billingview/restricted` }, false],
    ] as const) {
      const w = awsWorld();
      w.state.awsBudgets = [{ ...BUDGET, ...scope }];
      w.state.awsActions = [action("act-deny")];
      const report = await doctor(w);
      expect(report.ok, JSON.stringify(scope)).toBe(ok);
      expect(w.calls.filter(isWrite)).toEqual([]);
    }
    for (const CostFilters of [{ Region: "us-east-1" }, { Service: [42] }, null]) {
      const w = awsWorld();
      w.state.awsBudgets = [{ ...BUDGET, CostFilters }];
      w.state.awsActions = [action("act-deny")];
      expect(driftStage(await doctor(w))?.detail).toContain("unreadable CostFilters");
    }
  });

  it("[FD-EXEC-083] rejects reversed, failed and unknown action states, and accepts a null completed-parent token", async () => {
    for (const Status of [
      undefined,
      "REVERSE_SUCCESS",
      "EXECUTION_FAILURE",
      "unknown",
      "EXECUTION_SUCCESS",
    ]) {
      const w = awsWorld();
      w.state.awsActions = [action("act-deny", { Status })];
      const report = await doctor(w);
      expect(report.ok).toBe(Status === "EXECUTION_SUCCESS");
    }
    const w = awsWorld();
    w.state.awsActions = [action("act-deny")];
    w.state.awsParents[AWS_ACCOUNT] = {
      Parents: [{ Id: "r-abcd", Type: "ROOT" }],
      NextToken: null,
    };
    expect((await doctor(w)).ok).toBe(true);
  });

  it("[FD-EXEC-083] rejects future or unreadable time windows and a known cross-account launcher even with an SCP", async () => {
    for (const TimePeriod of [
      undefined,
      {},
      { Start: Date.now() / 1000 + 86400, End: Date.now() / 1000 + 172800 },
      { Start: "unknown" },
      null,
    ]) {
      const w = awsWorld();
      w.state.awsBudgets = [{ ...BUDGET, TimePeriod }];
      w.state.awsActions = [action("act-deny")];
      const report = await doctor(w);
      expect(report.ok).toBe(false);
      expect(driftStage(report)?.detail).toMatch(/active.*time|not active/);
    }
    const w = awsWorld();
    w.state.awsActions = [action("act-deny")];
    expect(
      (
        await doctor(
          w,
          overlayWith({
            budgetUsd: LIMIT_USD,
            launcherRoleArn: "arn:aws:iam::444455556666:role/fd-launcher",
          }),
        )
      ).ok,
    ).toBe(false);
  });

  it("[FD-EXEC-083] fails the drift stage when the deploy job carries no AWS credentials, or the overlay sets no aws.budgetUsd", async () => {
    const w = awsWorld();
    w.state.awsCredentials = false;
    w.state.awsActions = [action("act-deny")];
    const report = await deploy(w, AWS_OVERLAY);
    expect(report.stages.at(-1)).toEqual({
      stage: "drift",
      ok: false,
      detail: "aws-sts GetCallerIdentity: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set",
    });
    expect(awsCalls(w)).toEqual([]);
    expect(w.calls.filter(isWrite)).toEqual([]);

    // Without aws.budgetUsd the check fails on the overlay and reads nothing from AWS, even with no credentials.
    const unset = awsWorld();
    unset.state.awsCredentials = false;
    unset.state.awsActions = [action("act-deny")];
    const checked = await doctor(unset, overlayWith({ launchCap: 4 }));
    expect(checked.ok).toBe(false);
    expect(driftStage(checked)).toEqual({
      stage: "drift",
      ok: false,
      detail:
        "failure aws.budgetUsd: the overlay carries the aws kind and sets no AWS limit for the Budgets action to enforce",
    });
    expect(awsCalls(unset)).toEqual([]);
  });
});
