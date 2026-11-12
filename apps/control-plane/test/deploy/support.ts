// The account the control plane's deploy suites of `V-DEPLOY` run on (specs/verification.md § Harness catalog): `fd
// deploy` over the committed control-plane template and an overlay, the placeholder overlay by default. The account
// keeps each rendered Worker it deploys and answers the post-deploy probe of `GET /health` with this Worker's `fetch`,
// on the deployed Worker's vars and the Worker secrets the account holds. `serve` runs the deployed Worker under
// Miniflare on the same vars and secrets, with the D1 database, Durable Objects and R2 bucket its routes reach, so a
// suite sends the deployed Worker any request.
import {
  APP_PERMISSIONS,
  DeployTarget,
  MERGE_GATE_CHECKS,
  placeholderOverlay,
  TargetFailed,
  type OverlayValues,
  type RenderedWorker,
} from "@fractalboxdev/flare-dispatch-ops";
import { makeOperability, repositoryRoot, V2_WORKERS } from "@fractalboxdev/flare-dispatch-ops/cli";
import { Effect, Layer } from "effect";
import { build } from "esbuild";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import type { ControlPlaneEnv } from "../../src/config.ts";
import worker from "../../src/worker.ts";

export const ROOT = repositoryRoot(import.meta.dirname);

/** The committed control-plane template, without the dispatcher's Access applications, which these suites leave out. */
const { dispatcher: _dispatcher, ...CONTROL_PLANE } = V2_WORKERS.find(
  (w) => w.worker === "control-plane",
)!;

let bundled: Promise<string> | undefined;
/** The Worker script `wrangler deploy` uploads: `src/worker.ts` bundled, built once per suite file. */
const script = () =>
  (bundled ??= build({
    entryPoints: [join(import.meta.dirname, "../../src/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    external: ["cloudflare:*"],
  }).then((b) => b.outputFiles[0]!.text));

/** An account that deploys each rendered Worker and answers its hostname with that Worker's `fetch`. */
export const account = (
  secrets: Readonly<Record<string, string>>,
  overlay: OverlayValues = placeholderOverlay,
) => {
  const deployed = new Map<string, RenderedWorker>();
  const alarms: string[] = [];
  const probes: { status: number; body: unknown }[] = [];
  const varsOf = () =>
    (deployed.get("control-plane")?.config["vars"] ?? {}) as Readonly<Record<string, unknown>>;
  const target = Layer.succeed(DeployTarget, {
    readLocalFile: () => Effect.succeed(null),
    deployedSettings: () => Effect.succeed(null),
    lastRecord: () => Effect.succeed(null),
    appRegistration: Effect.succeed(APP_PERMISSIONS),
    requiredChecks: Effect.succeed([...MERGE_GATE_CHECKS, "flare-dispatch/check:ci"]),
    apiToken: () => Effect.succeed(null),
    awsBudgets: Effect.fail(
      new TargetFailed({ operation: "aws budgets", message: "the account has no AWS budgets" }),
    ),
    runnerWorkflow: () => Effect.succeed(null),
    applyD1Migrations: () => Effect.succeed([]),
    deployWorker: (r) =>
      Effect.sync(() => {
        deployed.set(r.worker, r);
        return {
          worker: r.worker,
          version: "v1",
          previousVersion: null,
          durableObjectMigrations: [],
        };
      }),
    probe: (r) =>
      Effect.promise(async () => {
        const vars = (deployed.get(r.worker)?.config["vars"] ?? {}) as Record<string, unknown>;
        const env = { ...vars, ...secrets } as unknown as ControlPlaneEnv;
        const host = overlay.hostnames[r.hostKey ?? ""];
        const res = await worker.fetch(new Request(`https://${host}/health`), env, {
          waitUntil: () => undefined,
        });
        probes.push({ status: res.status, body: await res.json() });
        return res.ok;
      }),
    floorCanary: () => Effect.succeed({ status: "passed" as const, digest: "sha256:0" }),
    writeRecord: () => Effect.void,
    raiseAlarm: (name, detail) => Effect.sync(() => void alarms.push(`${name}: ${detail}`)),
    accessApplications: Effect.succeed([]),
    putAccessApplication: () => Effect.void,
    deleteAccessApplication: () => Effect.void,
  });
  const fd = makeOperability({
    fail: (message) => new Error(message),
    root: ROOT,
    workers: [CONTROL_PLANE],
    target: () => target,
  });
  return {
    alarms,
    probes,
    /** The deployed control plane's vars, as the rendered configuration sets them. */
    vars: varsOf,
    deploy: () => Effect.runPromise(fd.deploy({ overlay: JSON.stringify(overlay), dryRun: false })),
    /**
     * The deployed control plane under Miniflare, on its rendered vars and the account's secrets; `vars` replaces
     * rendered vars, as an out-of-band `wrangler` edit would. The caller disposes it.
     */
    serve: async (vars: Readonly<Record<string, unknown>> = {}) => {
      const mf = new Miniflare({
        modules: [{ type: "ESModule", path: "worker.js", contents: await script() }],
        compatibilityDate: "2026-05-01",
        d1Databases: { DB: "control-plane" },
        durableObjects: {
          CHANNEL: { className: "ExecutorChannel", useSQLite: true },
          EXECUTION: { className: "ExecutionEngine", useSQLite: true },
          EPOCH_ANCHOR: { className: "EpochAnchor", useSQLite: true },
          MONITOR: { className: "LivenessMonitor", useSQLite: true },
          CACHE_LEDGER: { className: "CacheLedger", useSQLite: true },
        },
        r2Buckets: ["CACHE"],
        bindings: { ...varsOf(), ...vars, ...secrets } as Record<string, never>,
      });
      await mf.ready;
      return mf;
    },
  };
};
