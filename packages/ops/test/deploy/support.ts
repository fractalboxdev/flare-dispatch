// The fakes the deploy suites of `V-DEPLOY` run on (specs/verification.md § Harness catalog): `fd deploy` and `fd doctor`
// through the Operability service over the committed Worker templates and the placeholder overlay, with the live
// `DeployTarget` on fakes of the Cloudflare API, the GitHub API, `wrangler` and the Workers' hostnames. The fake
// Cloudflare account keeps each deployed Worker's settings, versions and Container applications and its Access
// applications between runs, so a suite deploys, changes the account out of band and deploys again. Access sits in
// front of the dispatcher's hostname as the account's applications configure it. AWS STS, AWS Budgets, IAM and AWS
// Organizations answer for one AWS account, and only requests whose SigV4 signature verifies.
import type { AwsCredentials } from "@fractalboxdev/flare-dispatch-agentic";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProfileDocument } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import {
  APP_PERMISSIONS,
  committedAccess,
  DeployTarget,
  onHostname,
  pathMatches,
  MERGE_GATE_CHECKS,
  parseJsonc,
  placeholderOverlay,
  renderTemplate,
  type AgenticRegistry,
  type AppPermissions,
  type OverlayValues,
  type WorkerConfig,
} from "../../src/index.ts";
import {
  cloudflareClient,
  githubClient,
  liveDeployTarget,
  makeOperability,
  recordKey,
  repositoryRoot,
  V2_WORKERS,
  type CommandRunner,
  type WorkerSpec,
} from "../../src/cli/index.ts";

export const ROOT = repositoryRoot(import.meta.dirname);
export const ACCOUNT = placeholderOverlay.accountId;
export const API = `/client/v4/accounts/${ACCOUNT}`;
export const CONTROL_PLANE = V2_WORKERS.find((w) => w.worker === "control-plane")!;
export const SCRIPT = "flare-dispatch-control-plane";
export const RECORD = recordKey(SCRIPT);
export const RENDERED = Effect.runSync(
  renderTemplate(
    "control-plane",
    readFileSync(join(ROOT, CONTROL_PLANE.templatePath), "utf8"),
    placeholderOverlay,
  ),
);
export const OVERLAY = JSON.stringify(placeholderOverlay);
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();

/** The AWS account the fake AWS endpoints answer for, and the credentials they accept. */
export const AWS_ACCOUNT = "111122223333";
export const AWS_CREDENTIALS: AwsCredentials = {
  accessKeyId: "ASIAFAKEKEYID",
  secretAccessKey: "fake-secret-key",
  sessionToken: "fake-session-token",
};

/** The AWS endpoints the fakes answer on, with the service each signs for. */
const AWS_SERVICES: Readonly<Record<string, string>> = {
  "sts.amazonaws.com": "sts",
  "budgets.amazonaws.com": "budgets",
  "iam.amazonaws.com": "iam",
  "organizations.us-east-1.amazonaws.com": "organizations",
};

/** The version id the fake `wrangler deploy` prints for the account's n-th deploy. */
export const version = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

const arr = (v: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];

/** One deployed Worker as the fake account holds it. */
export interface Script {
  bindings: Record<string, unknown>[];
  compatibility_date: string;
  crons: string[];
  domains: string[];
  containers: { name: string; max_instances: number; configuration: { image: string } }[];
  versions: string[];
}

/**
 * A Cloudflare account, a GitHub App installation, `wrangler` and the Workers' hostnames, behind one call log. The
 * account holds the committed Access applications for the placeholder overlay, the hostname's application with the
 * overlay's `access.aud`, unless `access` is `"none"`, as the App registration matches the committed manifest.
 */
export const world = (opts: { readonly access?: "committed" | "none" } = {}) => {
  const calls: string[] = [];
  const scripts = new Map<string, Script>();
  const secrets = new Map<string, Map<string, string>>();
  const objects = new Map<string, string>();
  const files = new Map<string, string>();
  const runs: (readonly string[])[] = [];
  const alarms: Record<string, unknown>[] = [];
  /** The account's Access applications by id, each as the API lists it. */
  const access = new Map<string, Record<string, unknown>>();
  let accessIds = 0;
  const state: {
    health: number;
    deploys: number;
    wranglerFails: boolean;
    /** Every Access write answers 403, as for a token that may read Access applications and not edit them. */
    accessFails: boolean;
    /** Every Access call answers 403, as for a token with no Access permission. */
    accessReadFails: boolean;
    /** The GitHub App's registration as `GET /app` answers it; the committed manifest by default. */
    app: AppPermissions;
    /** The status checks the default branch's ruleset requires; the merge gate and `check:ci` by default. */
    required: string[];
    /** Whether the deploy job's environment carries the AWS credentials. */
    awsCredentials: boolean;
    /** The AWS account's budgets and actions, as `DescribeBudgets` and `DescribeBudgetActionsForAccount` list them. */
    awsBudgets: Record<string, unknown>[];
    awsActions: Record<string, unknown>[];
    /** The documents of the account's IAM managed policies, by ARN, and of its SCPs, by policy id. */
    awsPolicies: Record<string, unknown>;
    awsManagementAccount: string;
    /** ListParents answers, keyed by child; tests can inject incomplete or cyclic ancestry. */
    awsParents: Record<string, Record<string, unknown>>;
  } = {
    health: 200,
    deploys: 0,
    wranglerFails: false,
    accessFails: false,
    accessReadFails: false,
    app: APP_PERMISSIONS,
    required: [...MERGE_GATE_CHECKS, "flare-dispatch/check:ci"],
    awsCredentials: true,
    awsBudgets: [],
    awsActions: [],
    awsPolicies: {},
    awsManagementAccount: "999900001111",
    awsParents: { [AWS_ACCOUNT]: { Parents: [{ Id: "r-abcd", Type: "ROOT" }] } },
  };

  /**
   * An application as the API stores it: an id, an AUD tag, and policies with the ids, precedence and rule lists it
   * adds. A created application takes a new AUD tag; a replaced one keeps its own.
   */
  const stored = (id: string, body: Record<string, unknown>, aud: unknown = `aud-${id}`) => ({
    ...body,
    id,
    aud,
    created_at: "2026-11-01T00:00:00Z",
    policies: arr(body["policies"]).map((p, i) => ({
      id: `${id}-policy-${i}`,
      precedence: i + 1,
      exclude: [],
      require: [],
      ...p,
    })),
  });

  /** The Access API: list in pages, create, replace and delete. */
  const accessApi = (method: string, url: URL, path: string, body: string): Response | null => {
    const m = /^\/access\/apps(?:\/([^/]+))?$/.exec(path);
    if (m === null) return null;
    if (state.accessReadFails || (state.accessFails && method !== "GET"))
      return Response.json(
        {
          success: false,
          result: null,
          errors: [{ code: 10000, message: "Authentication error" }],
        },
        { status: 403 },
      );
    const id = m[1];
    if (id === undefined && method === "GET") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const per = Number(url.searchParams.get("per_page") ?? "25");
      return ok([...access.values()].slice((page - 1) * per, page * per));
    }
    if (id === undefined && method === "POST") {
      const app = stored(`app-${++accessIds}`, JSON.parse(body) as Record<string, unknown>);
      access.set(app.id, app);
      return ok(app);
    }
    if (id === undefined || !access.has(id)) return new Response(null, { status: 404 });
    if (method === "PUT") {
      const app = stored(id, JSON.parse(body) as Record<string, unknown>, access.get(id)!["aud"]);
      access.set(id, app);
      return ok(app);
    }
    if (method === "DELETE") {
      access.delete(id);
      return ok({ id });
    }
    return new Response(null, { status: 405 });
  };

  /**
   * Access in front of the dispatcher's hostname: once an application covers the hostname, a request with no Access
   * session is sent to the team's login unless a bypass application covers its path.
   */
  const behindAccess = (host: string, path: string): boolean => {
    const apps = [...access.values()].filter((a) => onHostname(host, a["domain"] as string));
    if (!apps.some((a) => a["domain"] === host)) return false;
    return !apps.some(
      (a) =>
        a["domain"] !== host &&
        pathMatches((a["domain"] as string).slice(host.length), path) &&
        arr(a["policies"]).some((p) => p["decision"] === "bypass"),
    );
  };
  if (opts.access !== "none")
    for (const app of committedAccess(placeholderOverlay)!.applications) {
      const id = `app-${++accessIds}`;
      const aud =
        app.domain === placeholderOverlay.hostnames["dispatcher"]
          ? placeholderOverlay.access.aud
          : undefined;
      access.set(id, stored(id, JSON.parse(JSON.stringify(app)) as Record<string, unknown>, aud));
    }

  const secretBindings = (script: string) =>
    [...(secrets.get(script) ?? new Map<string, string>())].map(([name, text]) => ({
      type: "secret_text",
      name,
      // The real API never returns a secret's value; this one does, so a check that printed it would show.
      text,
    }));

  /** What `wrangler deploy` leaves in the account for one rendered configuration. */
  const deploy = (config: WorkerConfig): string | null => {
    const name = config["name"] as string;
    for (const s of arr(config["services"]))
      if (!scripts.has(s["service"] as string))
        return `could not resolve service ${String(s["service"])}`;
    const v = version(++state.deploys);
    const vars = Object.entries((config["vars"] ?? {}) as Record<string, unknown>).map(
      ([k, value]) =>
        typeof value === "string"
          ? { type: "plain_text", name: k, text: value }
          : { type: "json", name: k, json: value },
    );
    const dobs = (config["durable_objects"] as { bindings?: unknown } | undefined)?.bindings;
    scripts.set(name, {
      bindings: [
        ...arr(config["d1_databases"]).map((d) => ({
          type: "d1",
          name: d["binding"],
          id: d["database_id"],
        })),
        ...arr(config["kv_namespaces"]).map((k) => ({
          type: "kv_namespace",
          name: k["binding"],
          namespace_id: k["id"],
        })),
        ...arr(config["r2_buckets"]).map((b) => ({
          type: "r2_bucket",
          name: b["binding"],
          bucket_name: b["bucket_name"],
        })),
        ...arr(config["services"]).map((s) => ({
          type: "service",
          name: s["binding"],
          service: s["service"],
        })),
        ...arr(dobs).map((b) => ({
          type: "durable_object_namespace",
          name: b["name"],
          class_name: b["class_name"],
        })),
        ...vars,
      ],
      compatibility_date: (config["compatibility_date"] as string | undefined) ?? "",
      crons: [...((config["triggers"] as { crons?: string[] } | undefined)?.crons ?? [])],
      domains: arr(config["routes"]).map((r) => r["pattern"] as string),
      // wrangler builds each Container image and pushes it to the account's registry under the application's name.
      containers: arr(config["containers"]).map((c) => {
        const app = `${name}-${String(c["class_name"]).toLowerCase()}`;
        return {
          name: app,
          max_instances: c["max_instances"] as number,
          configuration: { image: `registry.cloudflare.com/${ACCOUNT}/${app}:${v.slice(0, 8)}` },
        };
      }),
      versions: [...(scripts.get(name)?.versions ?? []), v],
    });
    return null;
  };

  const runner: CommandRunner = async (_command, args) => {
    runs.push(args);
    const config = parseJsonc(files.get(args[args.indexOf("-c") + 1]!) ?? "{}");
    calls.push(`wrangler ${args[2]!} ${String(config["name"])}`);
    if (args.includes("rollback")) return { code: 1, stdout: "", stderr: "not expected" };
    if (args.includes("migrations"))
      return { code: 0, stdout: "No migrations to apply!", stderr: "" };
    if (state.wranglerFails)
      return { code: 1, stdout: "", stderr: "✘ [ERROR] A request to the API failed" };
    const refused = deploy(config);
    if (refused !== null) return { code: 1, stdout: "", stderr: `✘ [ERROR] ${refused}` };
    return {
      code: 0,
      stdout: `Uploaded ${String(config["name"])}\nCurrent Version ID: ${version(state.deploys)}\n`,
      stderr: "",
    };
  };

  const ok = (result: unknown) => Response.json({ success: true, result, errors: [] });
  const cloudflare = (method: string, url: URL, body: string): Response => {
    const path = url.pathname.slice(API.length);
    const objectKey = /^\/r2\/buckets\/flare-dispatch-artifacts\/objects\/(.+)$/.exec(path)?.[1];
    if (objectKey !== undefined) {
      if (method === "PUT") {
        objects.set(objectKey, body);
        return new Response(null, { status: 200 });
      }
      const stored = objects.get(objectKey);
      return stored === undefined ? new Response(null, { status: 404 }) : new Response(stored);
    }
    const accessAnswer = accessApi(method, url, path, body);
    if (accessAnswer !== null) return accessAnswer;
    if (method !== "GET") return new Response(null, { status: 405 });
    if (path === "/containers/applications")
      return ok([...scripts.values()].flatMap((s) => s.containers));
    if (path === "/workers/domains") {
      const s = scripts.get(url.searchParams.get("service") ?? "");
      return ok((s?.domains ?? []).map((hostname) => ({ hostname })));
    }
    const m = /^\/workers\/scripts\/([^/]+)\/(settings|schedules|deployments)$/.exec(path);
    const s = m === null ? undefined : scripts.get(m[1]!);
    if (m === null || s === undefined) return new Response(null, { status: 404 });
    if (m[2] === "settings")
      return ok({
        compatibility_date: s.compatibility_date,
        compatibility_flags: [],
        bindings: [...s.bindings, ...secretBindings(m[1]!)],
      });
    if (m[2] === "schedules") return ok({ schedules: s.crons.map((cron) => ({ cron })) });
    return ok({ deployments: [{ versions: [{ version_id: s.versions.at(-1) }] }] });
  };

  const github = (path: string): Response => {
    if (path === "/app")
      return Response.json({
        permissions: state.app.default_permissions,
        events: state.app.default_events,
      });
    if (path === "/repos/acme/fd/installation") return Response.json({ id: 9 });
    if (path === "/app/installations/9/access_tokens") return Response.json({ token: "ghs_read" });
    if (path === "/repos/acme/fd") return Response.json({ default_branch: "main" });
    if (path === "/repos/acme/fd/rules/branches/main")
      return Response.json([
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: state.required.map((context) => ({ context })),
          },
        },
      ]);
    return new Response(null, { status: 404 });
  };

  /** Independent Node-crypto SigV4 verification, including every sent x-amz-* header and content type. */
  const awsSigned = async (host: string, service: string, headers: Headers, body: string) => {
    const date = headers.get("x-amz-date");
    if (date === null) return false;
    if (
      headers.get("host") !== host ||
      headers.get("x-amz-security-token") !== AWS_CREDENTIALS.sessionToken
    )
      return false;
    const payloadHash = createHash("sha256").update(body).digest("hex");
    if (headers.get("x-amz-content-sha256") !== payloadHash) return false;
    const signed = [...headers.keys()]
      .filter((k) => k === "host" || k === "content-type" || k.startsWith("x-amz-"))
      .sort();
    const canonical = [
      "POST",
      "/",
      "",
      ...signed.map((k) => `${k}:${headers.get(k)!.trim().replace(/\s+/g, " ")}`),
      "",
      signed.join(";"),
      payloadHash,
    ].join("\n");
    const day = date.slice(0, 8);
    const scope = `${day}/us-east-1/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      date,
      scope,
      createHash("sha256").update(canonical).digest("hex"),
    ].join("\n");
    const h = (key: Buffer | string, value: string) =>
      createHmac("sha256", key).update(value).digest();
    const key = h(
      h(h(h(`AWS4${AWS_CREDENTIALS.secretAccessKey}`, day), "us-east-1"), service),
      "aws4_request",
    );
    const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
    return (
      headers.get("authorization") ===
      `AWS4-HMAC-SHA256 Credential=${AWS_CREDENTIALS.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}`
    );
  };

  /** AWS Budgets' JSON 1.1 operations, paged one item at a time so a reader must follow `NextToken`. */
  const budgetsApi = (headers: Headers, body: string): Response => {
    const target = headers.get("x-amz-target") ?? "";
    const request = JSON.parse(body) as {
      AccountId?: string;
      MaxResults?: number;
      NextToken?: string;
    };
    const reject = (message: string) =>
      Response.json({ __type: "ValidationException", Message: message }, { status: 400 });
    if (request.AccountId !== AWS_ACCOUNT) return reject("AccountId is not the caller's account");
    if (request.MaxResults !== undefined && request.MaxResults > 100)
      return reject("MaxResults must be at most 100");
    const listed =
      target === "AWSBudgetServiceGateway.DescribeBudgets"
        ? { key: "Budgets", items: state.awsBudgets }
        : target === "AWSBudgetServiceGateway.DescribeBudgetActionsForAccount"
          ? { key: "Actions", items: state.awsActions }
          : null;
    if (listed === null) return reject(`unknown operation ${target}`);
    const at = Number(request.NextToken ?? "0");
    return Response.json({
      [listed.key]: listed.items.slice(at, at + 1),
      ...(at + 1 < listed.items.length ? { NextToken: String(at + 1) } : {}),
    });
  };

  /** IAM's Query operations `GetPolicy` and `GetPolicyVersion`: each policy has the one version `v1`. */
  const iamApi = (body: string): Response => {
    const params = new URLSearchParams(body);
    const arn = params.get("PolicyArn") ?? "";
    const document = state.awsPolicies[arn];
    if (document === undefined)
      return new Response(
        "<ErrorResponse><Error><Code>NoSuchEntity</Code></Error></ErrorResponse>",
        {
          status: 404,
        },
      );
    const action = params.get("Action");
    if (action === "GetPolicy")
      return new Response(
        `<GetPolicyResponse><GetPolicyResult><Policy><Arn>${arn}</Arn><DefaultVersionId>v1</DefaultVersionId></Policy></GetPolicyResult></GetPolicyResponse>`,
      );
    if (action === "GetPolicyVersion" && params.get("VersionId") === "v1")
      return new Response(
        `<GetPolicyVersionResponse><GetPolicyVersionResult><PolicyVersion><Document>${encodeURIComponent(JSON.stringify(document))}</Document><VersionId>v1</VersionId></PolicyVersion></GetPolicyVersionResult></GetPolicyVersionResponse>`,
      );
    return new Response(
      "<ErrorResponse><Error><Code>InvalidAction</Code></Error></ErrorResponse>",
      {
        status: 400,
      },
    );
  };

  /** AWS Organizations' `DescribePolicy`: an SCP's content as a JSON string. */
  const organizationsApi = (headers: Headers, body: string): Response => {
    const target = headers.get("x-amz-target");
    if (target === "AWSOrganizationsV20161128.DescribeOrganization")
      return Response.json({
        Organization: { MasterAccountId: state.awsManagementAccount, FeatureSet: "ALL" },
      });
    if (target === "AWSOrganizationsV20161128.ListParents") {
      const { ChildId = "" } = JSON.parse(body) as { ChildId?: string };
      return Response.json(state.awsParents[ChildId] ?? { Parents: [] });
    }
    const { PolicyId: id = "" } = JSON.parse(body) as { PolicyId?: string };
    const document = state.awsPolicies[id];
    if (target !== "AWSOrganizationsV20161128.DescribePolicy")
      return Response.json({ __type: "InvalidInputException" }, { status: 400 });
    if (document === undefined)
      return Response.json({ __type: "PolicyNotFoundException" }, { status: 400 });
    return Response.json({
      Policy: {
        PolicySummary: { Id: id, Type: "SERVICE_CONTROL_POLICY" },
        Content: JSON.stringify(document),
      },
    });
  };

  const aws = async (host: string, headers: Headers, body: string): Promise<Response> => {
    const service = AWS_SERVICES[host]!;
    if (!(await awsSigned(host, service, headers, body)))
      return new Response("<Error><Code>SignatureDoesNotMatch</Code></Error>", { status: 403 });
    if (service === "budgets") return budgetsApi(headers, body);
    if (service === "iam") return iamApi(body);
    if (service === "organizations") return organizationsApi(headers, body);
    if (body !== "Action=GetCallerIdentity&Version=2011-06-15")
      return new Response("<Error><Code>InvalidAction</Code></Error>", { status: 400 });
    return new Response(
      `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:sts::${AWS_ACCOUNT}:assumed-role/fd-deploy/ci</Arn><UserId>AROAFAKE:ci</UserId><Account>${AWS_ACCOUNT}</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`,
      { headers: { "content-type": "text/xml" } },
    );
  };

  const fetcher = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push(`${method} ${url.host}${url.pathname}${url.search}`);
    if (AWS_SERVICES[url.host] !== undefined)
      return aws(url.host, new Headers(init?.headers), body);
    if (url.host === "api.cloudflare.com") return cloudflare(method, url, body);
    if (url.host === "api.github.com") return github(url.pathname);
    if (url.host === "alerts.example.com") {
      alarms.push(JSON.parse(body) as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }
    if (url.host === "dispatch.example.com")
      return behindAccess(url.host, url.pathname)
        ? new Response(null, {
            status: 302,
            headers: { location: "https://example.cloudflareaccess.com/cdn-cgi/access/login" },
          })
        : new Response("ok", { status: state.health });
    if (url.host === "docs.example.com") return new Response("ok");
    return new Response(null, { status: 599 });
  }) as unknown as typeof fetch;

  /** The account as it stands: every deployed Worker, its secrets and every stored object. */
  const snapshot = () =>
    JSON.stringify({
      scripts: [...scripts],
      secrets: [...secrets].map(([k, v]) => [k, [...v]]),
      objects: [...objects],
      access: [...access],
    });

  return {
    calls,
    scripts,
    objects,
    access,
    files,
    runs,
    alarms,
    state,
    runner,
    fetcher,
    snapshot,
    putSecret: (script: string, name: string, value: string) => {
      const m = secrets.get(script) ?? new Map<string, string>();
      m.set(name, value);
      secrets.set(script, m);
    },
  };
};
export type World = ReturnType<typeof world>;

/**
 * The live target on the fakes. The live floor canary fails for every Container class until mameko's coordinator
 * exposes one to run (MAMEKO-OPS-012, FD-OPS-050), and the control-plane template carries five; a suite that reaches
 * the record stage passes `canary: "passes"`, which answers the canary passed on the deployed digest.
 */
export const targetOn =
  (w: World, canary: "live" | "passes") =>
  (overlay: OverlayValues): Layer.Layer<DeployTarget> => {
    const live = liveDeployTarget({
      overlay,
      cloudflare: cloudflareClient("cf-token", w.fetcher),
      github: githubClient(w.fetcher),
      runner: w.runner,
      root: ROOT,
      apiToken: "cf-token",
      appPrivateKey: PEM,
      repository: "acme/fd",
      ...(w.state.awsCredentials ? { aws: AWS_CREDENTIALS } : {}),
      fetch: w.fetcher,
      writeFile: (path, text) => void w.files.set(path, text),
      removeFile: (path) => void w.files.delete(path),
    });
    if (canary === "live") return live;
    const service = Effect.runSync(
      Effect.provide(Effect.flatMap(DeployTarget, Effect.succeed), live),
    );
    return Layer.succeed(DeployTarget, {
      ...service,
      floorCanary: () => Effect.succeed({ status: "passed" as const, digest: "sha256:0" }),
    });
  };

export const fd = (
  w: World,
  opts: {
    workers?: readonly WorkerSpec[];
    canary?: "live" | "passes";
    /** The profile document the deploy carries; the production document by default. */
    profile?: ProfileDocument;
    /** The agentic recipes the run catalogue carries; `AGENTIC_CATALOG` by default. */
    agenticRegistry?: AgenticRegistry;
  } = {},
) =>
  makeOperability({
    fail: (message) => new Error(message),
    root: ROOT,
    workers: opts.workers ?? [CONTROL_PLANE],
    target: targetOn(w, opts.canary ?? "passes"),
    ...(opts.profile === undefined ? {} : { profile: opts.profile }),
    ...(opts.agenticRegistry === undefined ? {} : { agenticRegistry: opts.agenticRegistry }),
  });

export const deploy = (w: World, overlay = OVERLAY, opts: Parameters<typeof fd>[1] = {}) =>
  Effect.runPromise(fd(w, opts).deploy({ overlay, dryRun: false }));

/** The calls a run made from `from` on: what the second deploy did, after the first. */
export const since = (w: World, from: number) => w.calls.slice(from);
export const isWrite = (c: string) =>
  c.startsWith("wrangler ") || /^(PUT|POST|DELETE|PATCH) api\.cloudflare\.com/.test(c);
