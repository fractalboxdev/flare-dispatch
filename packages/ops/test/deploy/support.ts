// The fakes the deploy suites of `V-DEPLOY` run on (specs/verification.md § Harness catalog): `fd deploy` and `fd doctor`
// through the Operability service over the committed Worker templates and the placeholder overlay, with the live
// `DeployTarget` on fakes of the Cloudflare API, the GitHub API, `wrangler` and the Workers' hostnames. The fake
// Cloudflare account keeps each deployed Worker's settings, versions and Container applications between runs, so a
// suite deploys, changes the account out of band and deploys again.
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProfileDocument } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import {
  APP_PERMISSIONS,
  DeployTarget,
  MERGE_GATE_CHECKS,
  parseJsonc,
  placeholderOverlay,
  renderTemplate,
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

/** A Cloudflare account, a GitHub App installation, `wrangler` and the Workers' hostnames, behind one call log. */
export const world = () => {
  const calls: string[] = [];
  const scripts = new Map<string, Script>();
  const secrets = new Map<string, Map<string, string>>();
  const objects = new Map<string, string>();
  const files = new Map<string, string>();
  const runs: (readonly string[])[] = [];
  const alarms: Record<string, unknown>[] = [];
  const state: {
    health: number;
    deploys: number;
    wranglerFails: boolean;
    /** The GitHub App's registration as `GET /app` answers it; the committed manifest by default. */
    app: AppPermissions;
  } = { health: 200, deploys: 0, wranglerFails: false, app: APP_PERMISSIONS };

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
  } = {},
) =>
  makeOperability({
    fail: (message) => new Error(message),
    root: ROOT,
    workers: opts.workers ?? [CONTROL_PLANE],
    target: targetOn(w, opts.canary ?? "passes"),
    ...(opts.profile === undefined ? {} : { profile: opts.profile }),
  });

export const deploy = (w: World, overlay = OVERLAY, opts: Parameters<typeof fd>[1] = {}) =>
  Effect.runPromise(fd(w, opts).deploy({ overlay, dryRun: false }));

/** The calls a run made from `from` on: what the second deploy did, after the first. */
export const since = (w: World, from: number) => w.calls.slice(from);
export const isWrite = (c: string) =>
  c.startsWith("wrangler ") || /^(PUT|POST|DELETE|PATCH) api\.cloudflare\.com/.test(c);
