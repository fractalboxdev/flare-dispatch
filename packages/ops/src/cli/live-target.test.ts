import { generateKeyPairSync, createVerify } from "node:crypto";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  APP_PERMISSIONS,
  DeployTarget,
  MERGE_GATE_CHECKS,
  parseJsonc,
  placeholderOverlay,
  settingsFromConfig,
  type RenderedWorker,
} from "../index.ts";
import {
  appJwt,
  appliedMigrations,
  cloudflareClient,
  deployedVersion,
  githubClient,
  liveDeployTarget,
  recordKey,
  type CommandRunner,
} from "./index.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const ACCOUNT = `/client/v4/accounts/${placeholderOverlay.accountId}`;

const TEMPLATE = `{
  "name": "fd-cp",
  "keep_vars": false,
  "vars": { "PLANE_ID": "fd" },
  "d1_databases": [{ "binding": "DB", "database_name": "fd-db", "database_id": "d1-id", "migrations_dir": "migrations" }],
  "durable_objects": { "bindings": [{ "name": "MONITOR", "class_name": "LivenessMonitor" }] },
  "triggers": { "crons": ["* * * * *"] },
  "migrations": [{ "tag": "v1" }, { "tag": "v2" }],
}`;
const worker: RenderedWorker = {
  worker: "control-plane",
  text: TEMPLATE,
  config: parseJsonc(TEMPLATE),
  hostKey: "dispatcher",
  templatePath: "apps/cp/wrangler.jsonc",
};

/** A fake Cloudflare API, GitHub API, Worker hostname and alert sink behind one fetch. */
const world = (over: { deployed?: boolean; health?: number; record?: string | null } = {}) => {
  const calls: string[] = [];
  const objects = new Map<string, string>();
  if (over.record !== undefined && over.record !== null)
    objects.set(
      `${ACCOUNT}/r2/buckets/flare-dispatch-artifacts/objects/${recordKey("fd-cp")}`,
      over.record,
    );
  const ok = (result: unknown) => Response.json({ success: true, result });
  const fetcher = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.host}${url.pathname}${url.search}`);
    const path = url.pathname + url.search;
    if (url.host === "api.cloudflare.com") {
      if (path.includes("/r2/buckets/")) {
        if (method === "PUT") {
          objects.set(url.pathname, String(init?.body));
          return new Response(null, { status: 200 });
        }
        const body = objects.get(url.pathname);
        return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
      }
      if (over.deployed === false && path.includes("/workers/scripts/"))
        return new Response(null, { status: 404 });
      if (path.endsWith("/workers/scripts/fd-cp/settings"))
        return ok({
          compatibility_date: "",
          bindings: [
            { type: "d1", name: "DB", id: "d1-id" },
            { type: "durable_object_namespace", name: "MONITOR", class_name: "LivenessMonitor" },
            { type: "plain_text", name: "PLANE_ID", text: "fd" },
            { type: "secret_text", name: "GITHUB_APP_PRIVATE_KEY" },
          ],
        });
      if (path.endsWith("/workers/scripts/fd-cp/schedules"))
        return ok({ schedules: [{ cron: "* * * * *" }] });
      if (path.includes("/workers/domains")) return ok([]);
      if (path.endsWith("/containers/applications")) return ok([]);
      if (path.endsWith("/workers/scripts/fd-cp/deployments"))
        return ok({ deployments: [{ versions: [{ version_id: "prev-version" }] }] });
    }
    if (url.host === "api.github.com") {
      if (path === "/app")
        return Response.json({
          permissions: APP_PERMISSIONS.default_permissions,
          events: APP_PERMISSIONS.default_events,
        });
      if (path === "/repos/acme/fd/installation") return Response.json({ id: 9 });
      if (path === "/app/installations/9/access_tokens") return Response.json({ token: "ghs_x" });
      if (path === "/repos/acme/fd") return Response.json({ default_branch: "main" });
      if (path === "/repos/acme/fd/rules/branches/main")
        return Response.json([
          { type: "pull_request" },
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: MERGE_GATE_CHECKS.map((context) => ({ context })),
            },
          },
        ]);
    }
    if (url.host === "dispatch.example.com")
      return new Response("ok", { status: over.health ?? 200 });
    if (url.host === "alerts.example.com") return new Response(null, { status: 204 });
    return new Response(null, { status: 599 });
  }) as unknown as typeof fetch;
  return { calls, objects, fetcher };
};

const runner = () => {
  const runs: { args: readonly string[]; cwd: string; env?: Readonly<Record<string, string>> }[] =
    [];
  const run: CommandRunner = async (_cmd, args, options) => {
    runs.push({
      args,
      cwd: options.cwd,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    if (args.includes("deploy"))
      return {
        code: 0,
        stdout: "Uploaded fd-cp\nCurrent Version ID: 1f2e3d4c-aaaa-bbbb\n",
        stderr: "",
      };
    if (args.includes("migrations"))
      return { code: 0, stdout: "│ 0001_init.sql │ ✅ │\n│ 0002_alarms.sql │ ✅ │\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "unknown" };
  };
  return { runs, run };
};

const layerFor = (
  w: ReturnType<typeof world>,
  r = runner(),
  extra: { repository?: string; key?: string } = {},
) => {
  const files: string[] = [];
  return {
    files,
    r,
    layer: liveDeployTarget({
      overlay: placeholderOverlay,
      cloudflare: cloudflareClient("cf-token", w.fetcher),
      github: githubClient(w.fetcher),
      runner: r.run,
      root: "/repo",
      apiToken: "cf-token",
      appPrivateKey: extra.key ?? PEM,
      repository: extra.repository ?? "acme/fd",
      fetch: w.fetcher,
      now: () => 1_800_000_000_000,
      writeFile: (p) => void files.push(`write ${p}`),
      removeFile: (p) => void files.push(`remove ${p}`),
    }),
  };
};

const use = <A, E>(
  layer: ReturnType<typeof layerFor>["layer"],
  f: (t: typeof DeployTarget.Service) => Effect.Effect<A, E>,
) => Effect.runPromise(Effect.flatMap(DeployTarget, f).pipe(Effect.provide(layer)));

describe("live deploy target", () => {
  it("[FD-OPS-016] reads the deployed Worker's bindings, vars, crons, routes, compatibility settings and containers from the Cloudflare API", async () => {
    const w = world();
    const settings = await use(layerFor(w).layer, (t) => t.deployedSettings(worker));
    expect(settings).toEqual(
      settingsFromConfig("fd-cp", worker.config, ["GITHUB_APP_PRIVATE_KEY"]),
    );
    expect(w.calls.filter((c) => c.startsWith("GET api.cloudflare.com"))).toEqual([
      `GET api.cloudflare.com${ACCOUNT}/workers/scripts/fd-cp/settings`,
      `GET api.cloudflare.com${ACCOUNT}/workers/scripts/fd-cp/schedules`,
      `GET api.cloudflare.com${ACCOUNT}/workers/domains?service=fd-cp`,
      `GET api.cloudflare.com${ACCOUNT}/containers/applications`,
    ]);
    expect(
      await use(layerFor(world({ deployed: false })).layer, (t) => t.deployedSettings(worker)),
    ).toBeNull();
  });

  it("[FD-OPS-015] stores each Worker's rendered configuration in the artifacts bucket, and reads it back as the record", async () => {
    const w = world();
    const { layer } = layerFor(w);
    expect(await use(layer, (t) => t.lastRecord(worker))).toBeNull();
    await use(layer, (t) => t.writeRecord(worker));
    const stored = JSON.parse([...w.objects.values()][0]!);
    expect(stored).toEqual({
      rendered: TEMPLATE,
      secrets: ["GITHUB_APP_PRIVATE_KEY"],
      containers: [],
    });
    expect(await use(layer, (t) => t.lastRecord(worker))).toEqual(
      settingsFromConfig("fd-cp", worker.config, ["GITHUB_APP_PRIVATE_KEY"]),
    );
  });

  it("[FD-OPS-022] reads the App's registration with an App JWT", async () => {
    const w = world();
    expect(await use(layerFor(w).layer, (t) => t.appRegistration)).toEqual(APP_PERMISSIONS);
    const jwt = appJwt("12", PEM, 1_000);
    const [h, p, s] = jwt.split(".");
    const verify = createVerify("RSA-SHA256");
    verify.update(`${h}.${p}`);
    expect(verify.verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({
      iat: 940,
      exp: 1540,
      iss: "12",
    });
    const missing = await Effect.runPromise(
      Effect.flip(
        Effect.flatMap(DeployTarget, (t) => t.appRegistration).pipe(
          Effect.provide(layerFor(w, runner(), { key: "" }).layer),
        ),
      ),
    );
    expect(missing.message).toBe("GITHUB_APP_PRIVATE_KEY is not set");
  });

  it("[FD-VER-023] [FD-OPS-028] reads the default branch's required status checks through an installation token", async () => {
    const w = world();
    expect(await use(layerFor(w).layer, (t) => t.requiredChecks)).toEqual([...MERGE_GATE_CHECKS]);
    expect(w.calls).toContain("POST api.github.com/app/installations/9/access_tokens");
  });

  it("[FD-OPS-009] applies D1 migrations and deploys each Worker with wrangler on the rendered configuration, beside its template", async () => {
    const w = world({
      record: JSON.stringify({ rendered: TEMPLATE.replace(', { "tag": "v2" }', ""), secrets: [] }),
    });
    const t = layerFor(w);
    expect(await use(t.layer, (x) => x.applyD1Migrations([worker]))).toEqual([
      "0001_init.sql",
      "0002_alarms.sql",
    ]);
    const deployed = await use(t.layer, (x) => x.deployWorker(worker));
    expect(deployed).toEqual({
      worker: "control-plane",
      version: "1f2e3d4c-aaaa-bbbb",
      previousVersion: "prev-version",
      durableObjectMigrations: ["v2"],
    });
    expect(t.r.runs.map((r) => r.args)).toEqual([
      [
        "exec",
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "fd-db",
        "--remote",
        "-c",
        "/repo/apps/cp/.fd-rendered.jsonc",
      ],
      ["exec", "wrangler", "deploy", "-c", "/repo/apps/cp/.fd-rendered.jsonc"],
    ]);
    expect(t.r.runs[1]!.env).toEqual({
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: placeholderOverlay.accountId,
    });
    expect(t.files).toEqual([
      "write /repo/apps/cp/.fd-rendered.jsonc",
      "remove /repo/apps/cp/.fd-rendered.jsonc",
      "write /repo/apps/cp/.fd-rendered.jsonc",
      "remove /repo/apps/cp/.fd-rendered.jsonc",
    ]);
    expect(deployedVersion("no id")).toBeNull();
    expect(appliedMigrations("nothing")).toEqual([]);
  });

  it("[FD-OPS-013] probes GET /health on the overlay's hostname and pages deploy-probe-failed to the sink with R4", async () => {
    const healthy = world();
    expect(await use(layerFor(healthy).layer, (t) => t.probe(worker))).toBe(true);
    expect(healthy.calls).toContain("GET dispatch.example.com/health");
    expect(await use(layerFor(world({ health: 503 })).layer, (t) => t.probe(worker))).toBe(false);
    const w = world();
    await use(layerFor(w).layer, (t) =>
      t.raiseAlarm("deploy-probe-failed", "control-plane: GET /health failed", "page"),
    );
    expect(w.calls).toContain("POST alerts.example.com/hook");
  });

  it("[FD-ARCH-003] [FD-ARCH-004] the deploy's GitHub calls are reads; its one App-JWT POST mints a read-only token for one repository", async () => {
    const w = world();
    const { layer } = layerFor(w);
    await use(layer, (t) => t.appRegistration);
    await use(layer, (t) => t.requiredChecks);
    const github = w.calls.filter((c) => c.includes("api.github.com"));
    expect(github.filter((c) => !c.startsWith("GET "))).toEqual([
      "POST api.github.com/app/installations/9/access_tokens",
    ]);
    const minted: { repositories: string[]; permissions: Record<string, string> }[] = [];
    const capture = (async (input: string, init?: RequestInit) => {
      if (String(input).endsWith("/access_tokens")) minted.push(JSON.parse(String(init?.body)));
      return w.fetcher(input, init);
    }) as unknown as typeof fetch;
    await use(layerFor({ ...w, fetcher: capture }).layer, (t) => t.requiredChecks);
    expect(minted).toEqual([
      { repositories: ["fd"], permissions: { administration: "read", metadata: "read" } },
    ]);
  });

  it("[FD-OPS-050] the floor canary does not apply to a deploy with no Container class, and fails where the coordinator has none to run", async () => {
    const { layer } = layerFor(world());
    expect(await use(layer, (t) => t.floorCanary([worker]))).toMatchObject({
      status: "not-applicable",
    });
    const withContainers = {
      ...worker,
      config: { ...worker.config, containers: [{ class_name: "LeanPool" }] },
    };
    expect(await use(layer, (t) => t.floorCanary([withContainers]))).toMatchObject({
      status: "failed",
    });
  });
});
