// The live `DeployTarget`: the Cloudflare API for the deployed Workers, their schedules, domains and Container
// applications and the record of the last deploy in the artifacts bucket; `wrangler` for D1 migrations and Worker
// deploys; the GitHub API with the App JWT for the App's registration and the default branch's ruleset; the Workers'
// own hostnames for the post-deploy probes; the Cloudflare Access applications of the account; AWS STS, AWS Budgets, IAM
// and AWS Organizations, signed with SigV4, for the AWS account's Budgets actions and the policies they apply; and the
// overlay's alert sink for `deploy-probe-failed`.
import { signRequest, type AwsCredentials } from "@fractalboxdev/flare-dispatch-agentic";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Layer } from "effect";
import type { DeployedAccessApplication } from "../access-application.ts";
import { alarmMessage, RUNBOOK } from "../alarms.ts";
import {
  DeployTarget,
  scriptName,
  TargetFailed,
  type CanaryResult,
  type Deployed,
  type RenderedWorker,
} from "../deploy.ts";
import {
  POLICY_ACTION_TYPES,
  type AppPermissions,
  type AwsActionPolicy,
  type AwsBudget,
  type AwsBudgetAction,
  type AwsBudgets,
  type AwsPolicyStatement,
  type DeployedSettings,
} from "../drift.ts";
import type { OverlayValues } from "../overlay.ts";
import { parseJsonc } from "../render.ts";
import { migrationTags, settingsFromApi, settingsFromConfig, type ApiWorker } from "../settings.ts";
import {
  appJwt,
  appliedMigrations,
  deployedVersion,
  wrangler,
  type CloudflareClient,
  type CommandRunner,
  type GithubClient,
} from "./clients.ts";

/** What the live target runs with. */
export interface LiveTargetConfig {
  readonly overlay: OverlayValues;
  readonly cloudflare: CloudflareClient;
  readonly github: GithubClient;
  readonly runner: CommandRunner;
  /** The repository root; each template path is relative to it. */
  readonly root: string;
  /** The account-scoped API token `wrangler` reads from `CLOUDFLARE_API_TOKEN`. */
  readonly apiToken: string;
  /** The GitHub App's private key, a Worker secret on the control plane and a repository secret in the workflow. */
  readonly appPrivateKey?: string;
  /** `<owner>/<repo>` whose default branch's ruleset the drift check reads. */
  readonly repository?: string;
  /**
   * The AWS credentials the Budgets read signs with, from the deploy job's environment; the drift check of a deploy
   * that carries the `aws` kind fails without them (FD-EXEC-083).
   */
  readonly aws?: AwsCredentials;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Writes a rendered configuration beside its template, for `wrangler -c`; removed after use. */
  readonly writeFile?: (path: string, text: string) => void;
  readonly removeFile?: (path: string) => void;
}

/**
 * The record of a Worker's last deploy (FD-OPS-015): its rendered configuration, the secret names present when it
 * deployed and its Container applications as deployed. The rendered configuration names each Container image by its
 * Dockerfile, and the Cloudflare API reports the registry image `wrangler` built from it, so the record keeps the
 * deployed Container applications for the drift check to compare like with like (FD-OPS-016).
 */
export interface DeployRecord {
  readonly rendered: string;
  readonly secrets: readonly string[];
  readonly containers?: DeployedSettings["containers"];
}

/** The artifacts-bucket key of a Worker's record of its last deploy. */
export const recordKey = (scriptName: string): string => `deploys/${scriptName}/last.json`;

const RECORD_BUCKET = "ARTIFACTS";

/** The page size the Access applications are listed in. */
const ACCESS_PAGE = 100;

export { scriptName };

/** AWS STS, AWS Budgets, IAM and AWS Organizations serve from one global endpoint each, signed for `us-east-1`. */
const AWS_REGION = "us-east-1";
const STS_HOST = "sts.amazonaws.com";
const BUDGETS_HOST = "budgets.amazonaws.com";
const IAM_HOST = "iam.amazonaws.com";
const ORGANIZATIONS_HOST = "organizations.us-east-1.amazonaws.com";
/** The largest page `DescribeBudgets` and `DescribeBudgetActionsForAccount` return. */
const BUDGETS_PAGE = 100;

const arr = <T>(v: unknown): readonly T[] => (Array.isArray(v) ? (v as T[]) : []);

/** A policy statement's `Action` or `Resource`: one pattern or a list of them. */
const patterns = (v: unknown): readonly string[] =>
  typeof v === "string" ? [v] : arr<unknown>(v).filter((p): p is string => typeof p === "string");

/** The text of an XML element's content: its five predefined entities decoded. */
const xmlText = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

export const liveDeployTarget = (c: LiveTargetConfig): Layer.Layer<DeployTarget> => {
  const account = `/accounts/${c.overlay.accountId}`;
  const fetcher = c.fetch ?? fetch;
  const now = c.now ?? Date.now;
  const write = c.writeFile ?? ((p: string, t: string) => writeFileSync(p, t));
  const remove = c.removeFile ?? ((p: string) => rmSync(p, { force: true }));
  const bucket = c.overlay.r2[RECORD_BUCKET];

  /** Runs `wrangler` with the rendered configuration written beside its template. */
  const withRendered = <A>(
    r: RenderedWorker,
    use: (configPath: string) => Effect.Effect<A, TargetFailed>,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const dir = r.templatePath === undefined ? c.root : dirname(join(c.root, r.templatePath));
        const path = join(dir, ".fd-rendered.jsonc");
        write(path, r.text);
        return path;
      }),
      use,
      (path) => Effect.sync(() => remove(path)),
    );

  const env = { CLOUDFLARE_API_TOKEN: c.apiToken, CLOUDFLARE_ACCOUNT_ID: c.overlay.accountId };

  const deployedSettings = (r: RenderedWorker) =>
    Effect.gen(function* () {
      const name = scriptName(r);
      const settings = (yield* c.cloudflare.json(
        "GET",
        `${account}/workers/scripts/${name}/settings`,
      )) as ApiWorker["settings"] | null;
      if (settings === null) return null;
      const schedules = (yield* c.cloudflare.json(
        "GET",
        `${account}/workers/scripts/${name}/schedules`,
      )) as {
        schedules?: { cron?: string }[];
      } | null;
      const domains = arr<{ hostname?: string }>(
        yield* c.cloudflare.json(
          "GET",
          `${account}/workers/domains?service=${encodeURIComponent(name)}`,
        ),
      );
      const applications = arr<{
        name?: string;
        max_instances?: number;
        configuration?: { image?: string };
      }>(yield* c.cloudflare.json("GET", `${account}/containers/applications`));
      return settingsFromApi({
        settings,
        crons: (schedules?.schedules ?? []).flatMap((s) => (s.cron === undefined ? [] : [s.cron])),
        routes: domains.flatMap((d) => (d.hostname === undefined ? [] : [d.hostname])),
        containers: applications
          .filter((a) => a.name?.startsWith(`${name}-`) === true)
          .map((a) => ({
            class_name: a.name!.slice(name.length + 1),
            max_instances: a.max_instances ?? 0,
            image: a.configuration?.image ?? "",
          })),
      });
    });

  const readRecord = (r: RenderedWorker) =>
    Effect.gen(function* () {
      if (bucket === undefined)
        return yield* new TargetFailed({
          operation: "record",
          message: "the overlay names no r2.ARTIFACTS bucket",
        });
      const raw = yield* c.cloudflare.raw(
        "GET",
        `${account}/r2/buckets/${bucket}/objects/${recordKey(scriptName(r))}`,
      );
      if (raw === null) return null;
      return JSON.parse(raw) as DeployRecord;
    });

  const jwt = Effect.gen(function* () {
    if (c.appPrivateKey === undefined || c.appPrivateKey === "")
      return yield* new TargetFailed({
        operation: "github-app",
        message: "GITHUB_APP_PRIVATE_KEY is not set",
      });
    return appJwt(c.overlay.github.appId, c.appPrivateKey, Math.floor(now() / 1000));
  });

  /** Every Access application, page by page until a page holds no application not already listed. */
  const accessApplications = Effect.gen(function* () {
    const all = new Map<string, DeployedAccessApplication>();
    for (let page = 1; ; page++) {
      const listed = arr<DeployedAccessApplication>(
        yield* c.cloudflare.json(
          "GET",
          `${account}/access/apps?page=${page}&per_page=${ACCESS_PAGE}`,
        ),
      );
      const fresh = listed.filter((a) => !all.has(a.id));
      for (const a of fresh) all.set(a.id, a);
      if (listed.length < ACCESS_PAGE || fresh.length === 0) return [...all.values()];
    }
  });

  /** One signed `POST /` to an AWS endpoint; answers the response text. */
  const awsPost = (
    operation: string,
    host: string,
    service: string,
    headers: Record<string, string>,
    body: string,
  ) =>
    Effect.gen(function* () {
      const credentials = c.aws;
      if (credentials === undefined)
        return yield* new TargetFailed({
          operation,
          message: "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set",
        });
      const failed = (e: unknown) => new TargetFailed({ operation, message: String(e) });
      const signed = yield* Effect.tryPromise({
        try: () =>
          signRequest({
            credentials,
            region: AWS_REGION,
            service,
            host,
            canonicalPath: "/",
            body,
            now: new Date(now()),
            headers,
          }),
        catch: failed,
      });
      const res = yield* Effect.tryPromise({
        try: () => fetcher(`https://${host}/`, { method: "POST", headers: signed, body }),
        catch: failed,
      });
      const text = yield* Effect.tryPromise({ try: () => res.text(), catch: failed });
      if (!res.ok)
        return yield* new TargetFailed({
          operation,
          message: `${res.status} ${text.slice(0, 500)}`,
        });
      return text;
    });

  /** One operation of an AWS JSON 1.1 API: AWS Budgets or AWS Organizations. */
  const jsonCall = (
    operation: string,
    host: string,
    service: string,
    target: string,
    request: Record<string, unknown>,
  ) =>
    Effect.flatMap(
      awsPost(
        operation,
        host,
        service,
        { "content-type": "application/x-amz-json-1.1", "x-amz-target": target },
        JSON.stringify(request),
      ),
      (text) =>
        Effect.try({
          try: () => {
            const parsed: unknown = JSON.parse(text);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
              throw new Error("the AWS JSON response is not an object");
            return parsed as Record<string, unknown>;
          },
          catch: (e) => new TargetFailed({ operation, message: String(e) }),
        }),
    );

  /** One AWS Budgets operation. */
  const budgetsCall = (target: string, request: Record<string, unknown>) =>
    jsonCall(
      `aws-budgets ${target}`,
      BUDGETS_HOST,
      "budgets",
      `AWSBudgetServiceGateway.${target}`,
      request,
    );

  /** One IAM operation of the Query protocol; answers the XML response. */
  const iamCall = (action: string, params: Record<string, string>) =>
    awsPost(
      `aws-iam ${action}`,
      IAM_HOST,
      "iam",
      { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      new URLSearchParams({ Action: action, Version: "2010-05-08", ...params }).toString(),
    );

  /** Every item of a paged AWS Budgets list, following `NextToken`. */
  const budgetsPages = <T>(target: string, key: string, account: string) =>
    Effect.gen(function* () {
      const items: T[] = [];
      let next: string | undefined;
      do {
        const page = yield* budgetsCall(target, {
          AccountId: account,
          MaxResults: BUDGETS_PAGE,
          ...(target === "DescribeBudgets" ? { ShowFilterExpression: true } : {}),
          ...(next === undefined ? {} : { NextToken: next }),
        });
        items.push(...arr<T>(page[key]));
        next = typeof page["NextToken"] === "string" ? page["NextToken"] : undefined;
      } while (next !== undefined && next !== "");
      return items;
    });

  /** A policy document's statements; a document that does not parse fails the read. */
  const statementsOf = (operation: string, document: string) =>
    Effect.try({
      try: () => {
        const parsed = JSON.parse(document) as { Statement?: unknown };
        const statement = parsed.Statement;
        return (Array.isArray(statement) ? statement : statement === undefined ? [] : [statement])
          .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
          .map((s): AwsPolicyStatement => ({
            effect: typeof s["Effect"] === "string" ? s["Effect"] : "",
            actions: patterns(s["Action"]),
            resources: patterns(s["Resource"]),
            conditional: s["Condition"] !== undefined,
          }));
      },
      catch: (e) => new TargetFailed({ operation, message: `the policy document: ${String(e)}` }),
    });

  /** An IAM managed policy's default version's document: `GetPolicy`, then `GetPolicyVersion`. */
  const iamPolicyStatements = (policyArn: string) =>
    Effect.gen(function* () {
      const policy = yield* iamCall("GetPolicy", { PolicyArn: policyArn });
      const versionId = /<DefaultVersionId>\s*([^<\s]+)\s*<\/DefaultVersionId>/.exec(policy)?.[1];
      if (versionId === undefined)
        return yield* new TargetFailed({
          operation: "aws-iam GetPolicy",
          message: `policy ${policyArn} names no default version`,
        });
      const version = yield* iamCall("GetPolicyVersion", {
        PolicyArn: policyArn,
        VersionId: versionId,
      });
      const encoded = /<Document>([^<]*)<\/Document>/.exec(version)?.[1];
      if (encoded === undefined)
        return yield* new TargetFailed({
          operation: "aws-iam GetPolicyVersion",
          message: `policy ${policyArn} version ${versionId} carries no document`,
        });
      const document = yield* Effect.try({
        try: () => decodeURIComponent(xmlText(encoded)),
        catch: (e) =>
          new TargetFailed({ operation: "aws-iam GetPolicyVersion", message: String(e) }),
      });
      return yield* statementsOf("aws-iam GetPolicyVersion", document);
    });

  /** A policy's actual type and content: AWS Organizations `DescribePolicy`. */
  const scpPolicy = (policyId: string) =>
    Effect.gen(function* () {
      const described = yield* jsonCall(
        "aws-organizations DescribePolicy",
        ORGANIZATIONS_HOST,
        "organizations",
        "AWSOrganizationsV20161128.DescribePolicy",
        { PolicyId: policyId },
      );
      const policy = described["Policy"] as
        | { Content?: unknown; PolicySummary?: { Type?: unknown } }
        | undefined;
      const content = policy?.Content;
      const policyType = policy?.PolicySummary?.Type;
      if (typeof content !== "string" || typeof policyType !== "string")
        return yield* new TargetFailed({
          operation: "aws-organizations DescribePolicy",
          message: `policy ${policyId} carries no known type or content`,
        });
      return {
        policyType,
        statements: yield* statementsOf("aws-organizations DescribePolicy", content),
      };
    });

  type ActionDefinition = {
    IamActionDefinition?: {
      PolicyArn?: string;
      Roles?: string[];
      Users?: string[];
      Groups?: string[];
    };
    ScpActionDefinition?: { PolicyId?: string; TargetIds?: string[] };
  };

  /** The policy an action's `Definition` applies, with its document read from IAM or AWS Organizations. */
  const actionPolicy = (definition: ActionDefinition | undefined) =>
    Effect.gen(function* () {
      const iam = definition?.IamActionDefinition;
      if (iam?.PolicyArn !== undefined)
        return {
          id: iam.PolicyArn,
          targets: [
            ...arr<string>(iam.Roles),
            ...arr<string>(iam.Users),
            ...arr<string>(iam.Groups),
          ],
          roles: arr<string>(iam.Roles),
          statements: yield* iamPolicyStatements(iam.PolicyArn),
        } satisfies AwsActionPolicy;
      const scp = definition?.ScpActionDefinition;
      if (scp?.PolicyId !== undefined)
        return {
          id: scp.PolicyId,
          targets: arr<string>(scp.TargetIds),
          ...(yield* scpPolicy(scp.PolicyId)),
        } satisfies AwsActionPolicy;
      return null;
    });

  const awsBudgets = Effect.gen(function* () {
    const identity = yield* awsPost(
      "aws-sts GetCallerIdentity",
      STS_HOST,
      "sts",
      { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      "Action=GetCallerIdentity&Version=2011-06-15",
    );
    const account = /<Account>\s*([^<\s]+)\s*<\/Account>/.exec(identity)?.[1];
    if (account === undefined)
      return yield* new TargetFailed({
        operation: "aws-sts GetCallerIdentity",
        message: "the response names no account",
      });
    const budgets = yield* budgetsPages<{
      BudgetName?: string;
      BudgetType?: string;
      TimeUnit?: string;
      BudgetLimit?: { Amount?: string; Unit?: string };
      CostFilters?: Record<string, unknown>;
      FilterExpression?: unknown;
      BillingViewArn?: unknown;
      TimePeriod?: unknown;
    }>("DescribeBudgets", "Budgets", account);
    const actions = yield* budgetsPages<{
      ActionId?: string;
      BudgetName?: string;
      Status?: string;
      NotificationType?: string;
      ActionType?: string;
      ApprovalModel?: string;
      ActionThreshold?: { ActionThresholdValue?: number; ActionThresholdType?: string };
      Definition?: ActionDefinition;
    }>("DescribeBudgetActionsForAccount", "Actions", account);
    const organization = yield* Effect.gen(function* () {
      if (!actions.some((a) => a.ActionType === "APPLY_SCP_POLICY")) return undefined;
      const failed = (message: string) =>
        new TargetFailed({ operation: "aws-organizations membership", message });
      const call = (name: string, request: Record<string, unknown>) =>
        jsonCall(
          `aws-organizations ${name}`,
          ORGANIZATIONS_HOST,
          "organizations",
          `AWSOrganizationsV20161128.${name}`,
          request,
        );
      const described = yield* call("DescribeOrganization", {});
      const org = described["Organization"] as
        | { MasterAccountId?: unknown; ManagementAccountId?: unknown; FeatureSet?: unknown }
        | undefined;
      const managementAccount = org?.ManagementAccountId ?? org?.MasterAccountId;
      if (
        typeof managementAccount !== "string" ||
        !/^\d{12}$/.test(managementAccount) ||
        org?.FeatureSet !== "ALL"
      )
        return yield* failed(
          "the response does not prove an all-features organization's management account",
        );
      const ancestors: string[] = [];
      let child = account;
      // Organizations has a shallow tree; bound requests and refuse a cycle or an incomplete/paged answer.
      for (let depth = 0; depth < 32; depth++) {
        const page = yield* call("ListParents", { ChildId: child });
        const parents = arr<{ Id?: unknown; Type?: unknown }>(page["Parents"]);
        const parent = parents[0];
        if (
          parents.length !== 1 ||
          (page["NextToken"] !== undefined &&
            page["NextToken"] !== null &&
            page["NextToken"] !== "") ||
          typeof parent?.Id !== "string" ||
          ancestors.includes(parent.Id)
        )
          return yield* failed("the account's organization ancestry is incomplete or cyclic");
        if (parent.Type === "ROOT" && /^r-[a-z0-9]+$/.test(parent.Id)) {
          ancestors.push(parent.Id);
          const rootId = parent.Id;
          let next: string | undefined;
          const tokens = new Set<string>();
          // ALL features does not prove SCPs are enabled: a root can disable that policy type independently.
          for (let rootPage = 0; rootPage < 32; rootPage++) {
            const roots = yield* call("ListRoots", next === undefined ? {} : { NextToken: next });
            const listed = arr<{ Id?: unknown; PolicyTypes?: unknown }>(roots["Roots"]);
            if (
              !Array.isArray(roots["Roots"]) ||
              listed.some((r) => typeof r !== "object" || r === null)
            )
              return yield* failed("the organization root listing is unreadable");
            const root = listed.find((r) => r.Id === rootId);
            if (root !== undefined) {
              const policyTypes = arr<{ Type?: unknown; Status?: unknown }>(root.PolicyTypes);
              if (
                !Array.isArray(root.PolicyTypes) ||
                policyTypes.some((p) => typeof p !== "object" || p === null)
              )
                return yield* failed(`root ${rootId} carries no readable policy types`);
              const scpEnabled = policyTypes.some(
                (p) => p.Type === "SERVICE_CONTROL_POLICY" && p.Status === "ENABLED",
              );
              return { managementAccount, ancestors, scpEnabled };
            }
            const token = roots["NextToken"];
            if (token === undefined || token === null || token === "")
              return yield* failed(`ListRoots does not contain the account's root ${rootId}`);
            if (typeof token !== "string" || tokens.has(token))
              return yield* failed("the organization root listing is incomplete or cyclic");
            tokens.add(token);
            next = token;
          }
          return yield* failed("the organization root listing exceeds the 32-page read bound");
        }
        if (parent.Type !== "ORGANIZATIONAL_UNIT" || !/^ou-[a-z0-9]+-[a-z0-9]+$/.test(parent.Id))
          return yield* failed(
            "the account's parent is neither a known root nor organizational unit",
          );
        ancestors.push(parent.Id);
        child = parent.Id;
      }
      return yield* failed("the account's organization ancestry exceeds the 32-parent read bound");
    });
    return {
      account,
      ...(organization === undefined ? {} : { organization }),
      budgets: yield* Effect.try({
        try: () =>
          budgets.map((b): AwsBudget => ({
            name: b.BudgetName ?? "",
            type: b.BudgetType ?? "",
            limitAmount: Number(b.BudgetLimit?.Amount ?? Number.NaN),
            limitUnit: b.BudgetLimit?.Unit ?? "",
            timeUnit: b.TimeUnit ?? "",
            costFilters: (() => {
              const filters = b.CostFilters ?? {};
              if (typeof filters !== "object" || Array.isArray(filters) || b.CostFilters === null)
                throw new Error(`budget ${b.BudgetName} has unreadable CostFilters`);
              for (const values of Object.values(filters))
                if (!Array.isArray(values) || values.some((v) => typeof v !== "string"))
                  throw new Error(`budget ${b.BudgetName} has unreadable CostFilters`);
              return filters as Record<string, string[]>;
            })(),
            ...(b.FilterExpression === undefined ? {} : { filterExpression: b.FilterExpression }),
            ...(b.BillingViewArn === undefined ? {} : { billingViewArn: b.BillingViewArn }),
            ...(b.TimePeriod === undefined ? {} : { timePeriod: b.TimePeriod }),
          })),
        catch: (cause) =>
          new TargetFailed({ operation: "aws-budgets DescribeBudgets", message: String(cause) }),
      }),
      // Only an action that applies a policy has a document to read.
      actions: yield* Effect.forEach(actions, (a) =>
        Effect.map(
          POLICY_ACTION_TYPES.has(a.ActionType ?? "")
            ? actionPolicy(a.Definition)
            : Effect.succeed(null),
          (policy): AwsBudgetAction => ({
            id: a.ActionId ?? "",
            budgetName: a.BudgetName ?? "",
            status: a.Status ?? "",
            notificationType: a.NotificationType ?? "",
            actionType: a.ActionType ?? "",
            approvalModel: a.ApprovalModel ?? "",
            thresholdType: a.ActionThreshold?.ActionThresholdType ?? "",
            thresholdValue: a.ActionThreshold?.ActionThresholdValue ?? Number.NaN,
            policy,
          }),
        ),
      ),
      observedAt: now(),
    } satisfies AwsBudgets;
  });

  return Layer.succeed(DeployTarget, {
    deployedSettings,
    awsBudgets,
    accessApplications,
    putAccessApplication: (application, id) =>
      Effect.asVoid(
        id === null
          ? c.cloudflare.json("POST", `${account}/access/apps`, application)
          : c.cloudflare.json("PUT", `${account}/access/apps/${id}`, application),
      ),
    deleteAccessApplication: (id) =>
      Effect.asVoid(c.cloudflare.json("DELETE", `${account}/access/apps/${id}`)),
    lastRecord: (r) =>
      Effect.map(readRecord(r), (rec): DeployedSettings | null => {
        if (rec === null) return null;
        const settings = settingsFromConfig(scriptName(r), parseJsonc(rec.rendered), rec.secrets);
        return rec.containers === undefined
          ? settings
          : { ...settings, containers: rec.containers };
      }),
    appRegistration: Effect.gen(function* () {
      const app = (yield* c.github.json("GET", "/app", yield* jwt)) as {
        permissions?: Record<string, "read" | "write" | "admin">;
        events?: string[];
      };
      return {
        default_permissions: app.permissions ?? {},
        default_events: app.events ?? [],
      } satisfies AppPermissions;
    }),
    requiredChecks: Effect.gen(function* () {
      const repo = c.repository;
      if (repo === undefined || !repo.includes("/"))
        return yield* new TargetFailed({
          operation: "ruleset",
          message: "GITHUB_REPOSITORY names no <owner>/<repo>",
        });
      const appToken = yield* jwt;
      const installation = (yield* c.github.json(
        "GET",
        `/repos/${repo}/installation`,
        appToken,
      )) as { id: number };
      const { token } = (yield* c.github.json(
        "POST",
        `/app/installations/${installation.id}/access_tokens`,
        appToken,
        {
          repositories: [repo.split("/")[1]],
          permissions: { administration: "read", metadata: "read" },
        },
      )) as { token: string };
      const { default_branch } = (yield* c.github.json("GET", `/repos/${repo}`, token)) as {
        default_branch: string;
      };
      const rules = arr<{
        type?: string;
        parameters?: { required_status_checks?: { context?: string }[] };
      }>(
        yield* c.github.json(
          "GET",
          `/repos/${repo}/rules/branches/${encodeURIComponent(default_branch)}`,
          token,
        ),
      );
      return rules
        .filter((rule) => rule.type === "required_status_checks")
        .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
        .flatMap((check) => (check.context === undefined ? [] : [check.context]));
    }),
    applyD1Migrations: (rendered) =>
      Effect.gen(function* () {
        const applied: string[] = [];
        for (const r of rendered)
          for (const db of arr<{ database_name?: string; migrations_dir?: string }>(
            r.config["d1_databases"],
          )) {
            if (db.migrations_dir === undefined || db.database_name === undefined) continue;
            const stdout = yield* withRendered(r, (path) =>
              wrangler(
                c.runner,
                c.root,
                ["d1", "migrations", "apply", db.database_name!, "--remote", "-c", path],
                env,
              ),
            );
            applied.push(...appliedMigrations(stdout));
          }
        return applied;
      }),
    deployWorker: (r) =>
      Effect.gen(function* () {
        const name = scriptName(r);
        const deployments = (yield* c.cloudflare.json(
          "GET",
          `${account}/workers/scripts/${name}/deployments`,
        )) as {
          deployments?: { versions?: { version_id?: string }[] }[];
        } | null;
        const previous = deployments?.deployments?.[0]?.versions?.[0]?.version_id ?? null;
        const record = yield* readRecord(r);
        const before = new Set(record === null ? [] : migrationTags(parseJsonc(record.rendered)));
        const stdout = yield* withRendered(r, (path) =>
          wrangler(c.runner, c.root, ["deploy", "-c", path], env),
        );
        const version = deployedVersion(stdout);
        if (version === null)
          return yield* new TargetFailed({
            operation: `wrangler deploy ${name}`,
            message: "printed no version id",
          });
        return {
          worker: r.worker,
          version,
          previousVersion: previous,
          durableObjectMigrations: migrationTags(r.config).filter((t) => !before.has(t)),
        } satisfies Deployed;
      }),
    probe: (r) =>
      Effect.gen(function* () {
        const host = r.hostKey === undefined ? undefined : c.overlay.hostnames[r.hostKey];
        if (host === undefined)
          return yield* new TargetFailed({
            operation: `probe ${r.worker}`,
            message: "the overlay names no hostname",
          });
        const res = yield* Effect.tryPromise({
          try: () => fetcher(`https://${host}${r.probePath ?? "/health"}`, { redirect: "manual" }),
          catch: (e) => new TargetFailed({ operation: `probe ${r.worker}`, message: String(e) }),
        });
        return res.ok;
      }),
    floorCanary: (rendered) =>
      Effect.succeed<CanaryResult>(
        rendered.every((r) => arr(r.config["containers"]).length === 0)
          ? { status: "not-applicable", detail: "the deploy carries no Container class" }
          : {
              status: "failed",
              detail:
                "the coordinator exposes no floor canary to run on the deployed digest (MAMEKO-OPS-012)",
            },
      ),
    writeRecord: (r) =>
      Effect.gen(function* () {
        const deployed = yield* deployedSettings(r);
        if (bucket === undefined)
          return yield* new TargetFailed({
            operation: "record",
            message: "the overlay names no r2.ARTIFACTS bucket",
          });
        yield* c.cloudflare.raw(
          "PUT",
          `${account}/r2/buckets/${bucket}/objects/${recordKey(scriptName(r))}`,
          JSON.stringify({
            rendered: r.text,
            secrets: deployed?.secrets ?? [],
            containers: deployed?.containers ?? [],
          } satisfies DeployRecord),
        );
      }),
    raiseAlarm: (name, detail, severity) =>
      Effect.gen(function* () {
        const alarm = {
          name,
          severity,
          dedupeKey: name,
          state: "raised" as const,
          detail,
        };
        const sink = c.overlay.alerts.sink;
        if (!sink.startsWith("https://")) {
          yield* Effect.logError(
            `${alarmMessage(alarm)} (the email sink ${sink} is reached by the control plane only)`,
          );
          return;
        }
        yield* Effect.tryPromise(() =>
          fetcher(sink, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              alarm: name,
              severity,
              state: "raised",
              dedupe_key: name,
              runbook: severity === "page" ? (RUNBOOK[name] ?? null) : null,
              detail,
              message: alarmMessage(alarm),
            }),
          }),
        ).pipe(Effect.catch((e) => Effect.logError(`alarm ${name}: ${String(e)}`)));
      }),
  });
};
