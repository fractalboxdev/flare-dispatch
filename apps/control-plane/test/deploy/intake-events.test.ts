// The deploy suite of `V-DEPLOY` (specs/verification.md § Harness catalog) for intake's webhook-event filter
// (specs/intake.md FD-INT-027): `fd deploy` over the committed control-plane template and an overlay, then the
// deployed Worker on workerd through Miniflare, run with the vars the deploy rendered and a webhook secret, answers
// signed webhooks. The overlay's `intake.webhookEvents` reaches the Worker only through the rendered template.
import { createHmac } from "node:crypto";
import { join } from "node:path";
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
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = repositoryRoot(import.meta.dirname);
const WEBHOOK_SECRET = "webhook-secret-for-the-deploy-suite";

/** The committed control-plane template, without the dispatcher's Access applications, which this suite leaves out. */
const { dispatcher: _dispatcher, ...CONTROL_PLANE } = V2_WORKERS.find(
  (w) => w.worker === "control-plane",
)!;

/** `fd deploy` of one overlay into an account that records each Worker it deploys; the deployed `vars`. */
const deployedVars = async (overlay: OverlayValues): Promise<Record<string, unknown>> => {
  const deployed = new Map<string, RenderedWorker>();
  const target = Layer.succeed(DeployTarget, {
    readLocalFile: () => Effect.succeed(null),
    writeScanBundle: () => Effect.void,
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
    probe: () => Effect.succeed(true),
    floorCanary: () => Effect.succeed({ status: "passed" as const, digest: "sha256:0" }),
    writeRecord: () => Effect.void,
    raiseAlarm: () => Effect.void,
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
  const report = await Effect.runPromise(
    fd.deploy({ overlay: JSON.stringify(overlay), dryRun: false }),
  );
  expect(report.ok, JSON.stringify(report.stages)).toBe(true);
  return (deployed.get("control-plane")?.config["vars"] ?? {}) as Record<string, unknown>;
};

let script: string;
const workers: Miniflare[] = [];

/** The deployed Worker, run with the deployed vars and the webhook secret the account holds. */
const deployedWorker = async (vars: Record<string, unknown>) => {
  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.js", contents: script }],
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
    bindings: { ...(vars as Record<string, string>), WEBHOOK_SECRET },
  });
  workers.push(mf);
  await mf.ready;
  return mf;
};

/** A webhook delivery of `event`, signed with the deployment's webhook secret. */
const deliver = async (mf: Miniflare, event: string) => {
  const body = JSON.stringify({ zen: "Keep it logically awesome." });
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  const r = await mf.dispatchFetch("http://x/v1/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": `delivery-${event}-${Math.random()}`,
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body,
  });
  return { status: r.status, body: (await r.json()) as unknown };
};

const NOT_ALLOWED = { status: 202, body: { ignored: true, reason: "event_not_allowed" } };

beforeAll(async () => {
  const bundle = await build({
    entryPoints: [join(import.meta.dirname, "../../src/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    external: ["cloudflare:*"],
  });
  script = bundle.outputFiles[0]!.text;
});

afterAll(async () => {
  await Promise.all(workers.map((mf) => mf.dispose()));
});

describe("fd deploy of intake.webhookEvents", () => {
  it("[FD-INT-027] the deployed Worker ignores an event outside the overlay's intake.webhookEvents with 202 event_not_allowed, admits every supported event where the overlay sets no list, and none for an empty list", async () => {
    const absent = await deployedWorker(await deployedVars(placeholderOverlay));
    expect(await deliver(absent, "ping")).toEqual({ status: 200, body: { ok: true } });
    expect(await deliver(absent, "fork")).toEqual({
      status: 202,
      body: { ignored: true, reason: "event_not_supported" },
    });

    const listed = await deployedWorker(
      await deployedVars({ ...placeholderOverlay, intake: { webhookEvents: ["push"] } }),
    );
    expect(await deliver(listed, "ping")).toEqual(NOT_ALLOWED);

    const pinged = await deployedWorker(
      await deployedVars({ ...placeholderOverlay, intake: { webhookEvents: ["ping"] } }),
    );
    expect(await deliver(pinged, "ping")).toEqual({ status: 200, body: { ok: true } });

    const empty = await deployedWorker(
      await deployedVars({ ...placeholderOverlay, intake: { webhookEvents: [] } }),
    );
    expect(await deliver(empty, "ping")).toEqual(NOT_ALLOWED);
    expect(await deliver(empty, "push")).toEqual(NOT_ALLOWED);

    // The filter runs after the signature check: an unsigned delivery is refused whatever the list.
    const unsigned = await empty.dispatchFetch("http://x/v1/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": "unsigned",
        "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
      },
      body: "{}",
    });
    expect(unsigned.status).toBe(401);
  }, 120_000);
});
