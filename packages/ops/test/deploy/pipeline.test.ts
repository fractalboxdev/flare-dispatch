// The deploy suites of `V-DEPLOY` (specs/verification.md § Harness catalog): `fd deploy` and `fd doctor` through the
// Operability service over the committed Worker templates and the placeholder overlay, with the live `DeployTarget`
// on fakes of the Cloudflare API, the GitHub API, `wrangler` and the Workers' hostnames. The fake Cloudflare account
// keeps each deployed Worker's settings, versions and Container applications between runs, so a suite deploys, changes
// the account out of band and deploys again.
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP_PERMISSIONS,
  DeployTarget,
  MERGE_GATE_CHECKS,
  parseJsonc,
  placeholderOverlay,
  renderTemplate,
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

const ROOT = repositoryRoot(import.meta.dirname);
const ACCOUNT = placeholderOverlay.accountId;
const API = `/client/v4/accounts/${ACCOUNT}`;
const CONTROL_PLANE = V2_WORKERS.find((w) => w.worker === "control-plane")!;
const SCRIPT = "flare-dispatch-control-plane";
const RECORD = recordKey(SCRIPT);
const RENDERED = Effect.runSync(
  renderTemplate(
    "control-plane",
    readFileSync(join(ROOT, CONTROL_PLANE.templatePath), "utf8"),
    placeholderOverlay,
  ),
);
const OVERLAY = JSON.stringify(placeholderOverlay);
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();

/** The version id the fake `wrangler deploy` prints for the account's n-th deploy. */
const version = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

const arr = (v: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];

/** One deployed Worker as the fake account holds it. */
interface Script {
  bindings: Record<string, unknown>[];
  compatibility_date: string;
  crons: string[];
  domains: string[];
  containers: { name: string; max_instances: number; configuration: { image: string } }[];
  versions: string[];
}

/** A Cloudflare account, a GitHub App installation, `wrangler` and the Workers' hostnames, behind one call log. */
const world = () => {
  const calls: string[] = [];
  const scripts = new Map<string, Script>();
  const secrets = new Map<string, Map<string, string>>();
  const objects = new Map<string, string>();
  const files = new Map<string, string>();
  const runs: (readonly string[])[] = [];
  const alarms: Record<string, unknown>[] = [];
  const state = { health: 200, deploys: 0, wranglerFails: false };

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
        permissions: APP_PERMISSIONS.default_permissions,
        events: APP_PERMISSIONS.default_events,
      });
    if (path === "/repos/acme/fd/installation") return Response.json({ id: 9 });
    if (path === "/app/installations/9/access_tokens") return Response.json({ token: "ghs_read" });
    if (path === "/repos/acme/fd") return Response.json({ default_branch: "main" });
    if (path === "/repos/acme/fd/rules/branches/main")
      return Response.json([
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [...MERGE_GATE_CHECKS, "flare-dispatch/check:ci"].map(
              (context) => ({ context }),
            ),
          },
        },
      ]);
    return new Response(null, { status: 404 });
  };

  const fetcher = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push(`${method} ${url.host}${url.pathname}${url.search}`);
    if (url.host === "api.cloudflare.com") return cloudflare(method, url, body);
    if (url.host === "api.github.com") return github(url.pathname);
    if (url.host === "alerts.example.com") {
      alarms.push(JSON.parse(body) as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }
    if (url.host === "dispatch.example.com") return new Response("ok", { status: state.health });
    if (url.host === "docs.example.com") return new Response("ok");
    return new Response(null, { status: 599 });
  }) as unknown as typeof fetch;

  /** The account as it stands: every deployed Worker, its secrets and every stored object. */
  const snapshot = () =>
    JSON.stringify({
      scripts: [...scripts],
      secrets: [...secrets].map(([k, v]) => [k, [...v]]),
      objects: [...objects],
    });

  return {
    calls,
    scripts,
    objects,
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
type World = ReturnType<typeof world>;

/**
 * The live target on the fakes. The live floor canary fails for every Container class until mameko's coordinator
 * exposes one to run (MAMEKO-OPS-012, FD-OPS-050), and the control-plane template carries five; a suite that reaches
 * the record stage passes `canary: "passes"`, which answers the canary passed on the deployed digest.
 */
const targetOn =
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

const fd = (w: World, opts: { workers?: readonly WorkerSpec[]; canary?: "live" | "passes" } = {}) =>
  makeOperability({
    fail: (message) => new Error(message),
    root: ROOT,
    workers: opts.workers ?? [CONTROL_PLANE],
    target: targetOn(w, opts.canary ?? "passes"),
  });

const deploy = (w: World, overlay = OVERLAY, opts: Parameters<typeof fd>[1] = {}) =>
  Effect.runPromise(fd(w, opts).deploy({ overlay, dryRun: false }));

/** The calls a run made from `from` on: what the second deploy did, after the first. */
const since = (w: World, from: number) => w.calls.slice(from);
const isWrite = (c: string) =>
  c.startsWith("wrangler ") || /^(PUT|POST|DELETE|PATCH) api\.cloudflare\.com/.test(c);

// A second Worker whose template binds the control plane as a service, beside the committed templates.
let edgeDir: string;
let EDGE: WorkerSpec;
beforeAll(() => {
  mkdirSync(join(ROOT, ".tmp"), { recursive: true });
  edgeDir = mkdtempSync(join(ROOT, ".tmp", "deploy-harness-"));
  writeFileSync(
    join(edgeDir, "wrangler.jsonc"),
    `{
  "name": "flare-dispatch-edge",
  "account_id": "{{accountId}}",
  "keep_vars": false,
  "triggers": { "crons": ["* * * * *"] },
  "services": [{ "binding": "CONTROL_PLANE", "service": "${SCRIPT}" }],
}`,
  );
  EDGE = {
    worker: "edge",
    templatePath: relative(ROOT, join(edgeDir, "wrangler.jsonc")),
    hostKey: "docs",
    probePath: "/",
  };
});
afterAll(() => rmSync(edgeDir, { recursive: true, force: true }));

describe("fd deploy over the committed templates and the placeholder overlay", () => {
  it("[FD-OPS-003] rejects an overlay key the value schema does not declare, naming its path, before any Cloudflare call", async () => {
    const w = world();
    const overlay = JSON.stringify({
      ...placeholderOverlay,
      alerts: { ...placeholderOverlay.alerts, pager: "https://pager.example.com" },
    });
    const report = await deploy(w, overlay);
    expect(report.ok).toBe(false);
    expect(report.stages).toEqual([
      { stage: "decode", ok: false, detail: expect.stringContaining("alerts.pager") },
    ]);
    expect(w.calls).toEqual([]);
    expect(w.runs).toEqual([]);
  });

  it("[FD-OPS-004] rejects an overlay that lacks a required value, naming its path, before any Cloudflare call", async () => {
    const w = world();
    const { aud: _aud, ...access } = placeholderOverlay.access;
    const report = await deploy(w, JSON.stringify({ ...placeholderOverlay, access }));
    expect(report.ok).toBe(false);
    expect(report.stages).toEqual([
      { stage: "decode", ok: false, detail: expect.stringContaining("access.aud") },
    ]);
    expect(w.calls).toEqual([]);
    expect(w.runs).toEqual([]);
  });

  it("[FD-OPS-009] runs decode, render, drift, migrations, deploys and probes in order, and stops at the first stage that fails", async () => {
    const w = world();
    const report = await deploy(w);
    expect(report.stages.map((s) => [s.stage, s.ok])).toEqual([
      ["decode", true],
      ["render", true],
      ["drift", true],
      ["migrations", true],
      ["deploy", true],
      ["probes", true],
      ["record", true],
    ]);
    // The drift check's last read, the deploy, the probe and the record, in that order; no other write.
    const at = (call: string) => w.calls.indexOf(call);
    const order = [
      at("GET api.github.com/repos/acme/fd/rules/branches/main"),
      at(`wrangler deploy ${SCRIPT}`),
      at("GET dispatch.example.com/health"),
      at(`PUT api.cloudflare.com${API}/r2/buckets/flare-dispatch-artifacts/objects/${RECORD}`),
    ];
    expect(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]!))).toBe(true);
    expect(w.calls.filter(isWrite)).toEqual([
      `wrangler deploy ${SCRIPT}`,
      `PUT api.cloudflare.com${API}/r2/buckets/flare-dispatch-artifacts/objects/${RECORD}`,
    ]);

    // A failing deploy stage: nothing after it runs.
    w.state.wranglerFails = true;
    const from = w.calls.length;
    const failed = await deploy(w);
    expect(failed.ok).toBe(false);
    expect(failed.stages.map((s) => [s.stage, s.ok])).toEqual([
      ["decode", true],
      ["render", true],
      ["drift", true],
      ["migrations", true],
      ["deploy", false],
    ]);
    expect(since(w, from).filter((c) => c.includes("/health") || c.startsWith("PUT "))).toEqual([]);

    // A failing drift stage: no deploy step runs.
    w.state.wranglerFails = false;
    w.scripts.get(SCRIPT)!.crons = ["*/5 * * * *"];
    const before = w.calls.length;
    const drifted = await deploy(w);
    expect(drifted.stages.at(-1)).toMatchObject({ stage: "drift", ok: false });
    expect(since(w, before).filter(isWrite)).toEqual([]);
  });

  it("[FD-OPS-010] deploys a Worker only after every Worker it binds as a service, matched by script name", async () => {
    const w = world();
    // The edge Worker is listed first; its service binding names the control plane's script.
    const report = await deploy(w, OVERLAY, { workers: [EDGE, CONTROL_PLANE] });
    expect(report.ok).toBe(true);
    expect(w.calls.filter((c) => c.startsWith("wrangler deploy"))).toEqual([
      `wrangler deploy ${SCRIPT}`,
      "wrangler deploy flare-dispatch-edge",
    ]);
  });

  it("[FD-OPS-013] a failed post-deploy probe exits non-zero, pages deploy-probe-failed and prints each Worker's rollback line", async () => {
    // First deploy: the Durable Object migrations v1 and v2 are new, so the control plane must fix forward.
    const first = world();
    first.state.health = 503;
    const fresh = await deploy(first);
    expect(fresh.ok).toBe(false);
    expect(fresh.stages.at(-1)).toMatchObject({ stage: "probes", ok: false });
    expect(fresh.stages.at(-1)!.detail).toContain(
      "control-plane: fix forward: rollback blocked by migration v1",
    );

    // A later deploy carrying no migration: the rollback command names the previous version and the script.
    const w = world();
    expect((await deploy(w)).ok).toBe(true);
    w.state.health = 503;
    const report = await deploy(w);
    expect(report.ok).toBe(false);
    const probes = report.stages.at(-1)!;
    expect(probes).toMatchObject({ stage: "probes", ok: false });
    expect(probes.detail.split("\n")).toEqual([
      "control-plane: GET /health failed",
      `wrangler rollback ${version(1)} --name ${SCRIPT}`,
    ]);
    expect(w.alarms).toEqual([
      expect.objectContaining({ alarm: "deploy-probe-failed", severity: "page", state: "raised" }),
    ]);
  });

  it("[FD-OPS-014] never rolls a Worker back: after a failed probe the new version stays deployed until the operator acts", async () => {
    const w = world();
    expect((await deploy(w)).ok).toBe(true);
    w.state.health = 503;
    const from = w.calls.length;
    expect((await deploy(w)).ok).toBe(false);
    expect(w.runs.some((args) => args.includes("rollback"))).toBe(false);
    expect(
      since(w, from).filter((c) => /^(POST|PUT|PATCH|DELETE) api\.cloudflare\.com/.test(c)),
    ).toEqual([]);
    expect(w.scripts.get(SCRIPT)!.versions).toEqual([version(1), version(2)]);
  });

  it("[FD-OPS-015] a clean deploy stores each Worker's rendered configuration in the artifacts bucket as the record", async () => {
    // A failed probe stores no record.
    const failed = world();
    failed.state.health = 503;
    await deploy(failed);
    expect(failed.objects.has(RECORD)).toBe(false);

    const w = world();
    w.putSecret(SCRIPT, "GITHUB_APP_PRIVATE_KEY", "pem-value");
    expect((await deploy(w)).ok).toBe(true);
    const record = JSON.parse(w.objects.get(RECORD)!) as { rendered: string; secrets: string[] };
    expect(record.rendered).toBe(RENDERED);
    expect(record.secrets).toEqual(["GITHUB_APP_PRIVATE_KEY"]);
    const put = w.calls.findIndex((c) => c.startsWith("PUT ") && c.endsWith(RECORD));
    expect(put).toBeGreaterThan(w.calls.indexOf("GET dispatch.example.com/health"));
  });

  it("[FD-OPS-016] reads each deployed Worker's settings through the Cloudflare API and compares them with the record before any deploy step", async () => {
    const w = world();
    expect((await deploy(w)).ok).toBe(true);
    const from = w.calls.length;
    expect((await deploy(w)).ok).toBe(true);
    const second = since(w, from);
    const beforeWrite = second.slice(0, second.findIndex(isWrite));
    for (const read of [
      `${API}/workers/scripts/${SCRIPT}/settings`,
      `${API}/workers/scripts/${SCRIPT}/schedules`,
      `${API}/workers/domains?service=${SCRIPT}`,
      `${API}/containers/applications`,
      `${API}/r2/buckets/flare-dispatch-artifacts/objects/${RECORD}`,
    ])
      expect(beforeWrite).toContain(`GET api.cloudflare.com${read}`);

    // The record compares like with like: right after a deploy, nothing drifts, Container images included.
    const clean = await Effect.runPromise(fd(w).doctor(OVERLAY));
    expect(clean.stages.at(-1)).toEqual({ stage: "drift", ok: true, detail: "" });

    // A Container application resized out of band is a drift.
    w.scripts.get(SCRIPT)!.containers[0]!.max_instances = 1;
    const resized = await Effect.runPromise(fd(w).doctor(OVERLAY));
    expect(resized.stages.at(-1)).toMatchObject({ stage: "drift", ok: false });
    expect(resized.stages.at(-1)!.detail).toContain("control-plane.containers.leanpool");
  });

  it("[FD-OPS-017] a deployed setting that differs from the record fails the drift check with both values, secrets by name only", async () => {
    const w = world();
    w.putSecret(SCRIPT, "GITHUB_APP_PRIVATE_KEY", "pem-value");
    expect((await deploy(w)).ok).toBe(true);
    const cp = w.scripts.get(SCRIPT)!;
    cp.bindings = cp.bindings.map((b) =>
      b["name"] === "ALERT_SINK" ? { ...b, text: "https://other.example.com/hook" } : b,
    );
    cp.crons = ["*/5 * * * *"];
    w.putSecret(SCRIPT, "ROGUE_TOKEN", "hunter2-value");
    w.putSecret(SCRIPT, "GITHUB_APP_PRIVATE_KEY", "rotated-pem-value");
    const from = w.calls.length;
    const report = await deploy(w);
    expect(report.ok).toBe(false);
    const drift = report.stages.at(-1)!;
    expect(drift).toMatchObject({ stage: "drift", ok: false });
    expect(drift.detail.split("\n").sort()).toEqual([
      'control-plane.crons: deployed ["*/5 * * * *"], recorded ["* * * * *"]',
      "control-plane.secrets.ROGUE_TOKEN: secret ROGUE_TOKEN present on the deployed Worker, absent in the record",
      'control-plane.vars.ALERT_SINK: deployed "https://other.example.com/hook", recorded "https://alerts.example.com/hook"',
    ]);
    expect(drift.detail).not.toMatch(/hunter2-value|pem-value/);
    expect(since(w, from).filter(isWrite)).toEqual([]);
  });

  it("[FD-OPS-024] fd doctor runs every drift check over the committed templates and changes no Cloudflare or GitHub state", async () => {
    const w = world();
    expect((await deploy(w)).ok).toBe(true);
    const before = w.snapshot();
    const from = w.calls.length;
    const report = await Effect.runPromise(fd(w, { workers: V2_WORKERS }).doctor(OVERLAY));
    expect(report.stages.map((s) => s.stage)).toEqual(["decode", "render", "drift"]);
    const doctor = since(w, from);
    for (const read of [
      `GET api.cloudflare.com${API}/workers/scripts/${SCRIPT}/settings`,
      `GET api.cloudflare.com${API}/workers/scripts/flare-dispatch-docs/settings`,
      `GET api.cloudflare.com${API}/r2/buckets/flare-dispatch-artifacts/objects/${RECORD}`,
      "GET api.github.com/app",
      "GET api.github.com/repos/acme/fd/rules/branches/main",
    ])
      expect(doctor).toContain(read);
    expect(doctor.filter((c) => c.includes("api.cloudflare.com") && !c.startsWith("GET "))).toEqual(
      [],
    );
    // The one GitHub POST mints the read-only installation token the ruleset read needs.
    expect(doctor.filter((c) => c.includes("api.github.com") && !c.startsWith("GET "))).toEqual([
      "POST api.github.com/app/installations/9/access_tokens",
    ]);
    expect(doctor.filter((c) => c.startsWith("wrangler "))).toEqual([]);
    expect(w.files.size).toBe(0);
    expect(w.alarms).toEqual([]);
    expect(w.snapshot()).toBe(before);
  });
});
