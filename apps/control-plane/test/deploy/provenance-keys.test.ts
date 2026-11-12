// The deploy suite of `V-DEPLOY` (specs/verification.md § Harness catalog) for the control plane's key distinctness
// (specs/provenance.md § Keys): `fd deploy` over the committed control-plane template and the placeholder overlay,
// whose post-deploy probe requests this Worker's `GET /health` with the deployed Worker's vars and the Worker secrets
// the account holds. Worker secret values are write-only to the deploy, so the deployed Worker checks its own keys and
// the probe reads the answer.
import {
  APP_PERMISSIONS,
  DeployTarget,
  MERGE_GATE_CHECKS,
  placeholderOverlay,
  TargetFailed,
  type RenderedWorker,
} from "@fractalboxdev/flare-dispatch-ops";
import { makeOperability, repositoryRoot, V2_WORKERS } from "@fractalboxdev/flare-dispatch-ops/cli";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { ControlPlaneEnv } from "../../src/config.ts";
import worker from "../../src/worker.ts";

const ROOT = repositoryRoot(import.meta.dirname);
const OVERLAY = JSON.stringify(placeholderOverlay);

/** The committed control-plane template, without the dispatcher's Access applications, which this suite leaves out. */
const { dispatcher: _dispatcher, ...CONTROL_PLANE } = V2_WORKERS.find(
  (w) => w.worker === "control-plane",
)!;

/** An account that deploys each rendered Worker and answers its hostname with that Worker's `fetch`. */
const account = (secrets: Readonly<Record<string, string>>) => {
  const deployed = new Map<string, RenderedWorker>();
  const alarms: string[] = [];
  const probes: { status: number; body: unknown }[] = [];
  const target = Layer.succeed(DeployTarget, {
    deployedSettings: () => Effect.succeed(null),
    lastRecord: () => Effect.succeed(null),
    appRegistration: Effect.succeed(APP_PERMISSIONS),
    requiredChecks: Effect.succeed([...MERGE_GATE_CHECKS, "flare-dispatch/check:ci"]),
    awsBudgets: Effect.fail(
      new TargetFailed({ operation: "aws budgets", message: "the account has no AWS budgets" }),
    ),
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
        const host = placeholderOverlay.hostnames[r.hostKey ?? ""];
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
    deploy: () => Effect.runPromise(fd.deploy({ overlay: OVERLAY, dryRun: false })),
  };
};

const DISTINCT = {
  PROVENANCE_KEY: "provenance-key-value",
  OIDC_SIGNING_JWK: "oidc-key-value",
  LOG_KEY: "log-key-value",
  LINK_KEY: "link-key-value",
  COMPILE_CACHE_SECRET: "compile-cache-value",
  CACHE_TOKEN_SECRET: "cache-token-value",
  INSTALL_STATE_KEY: "install-state-value",
};

describe("fd deploy against the control plane's own key check", () => {
  it("[FD-PROV-033] fd deploy fails its post-deploy probe and pages when the control plane's provenance key equals its OIDC key, its log key or a capability-token key, and passes with every key distinct", async () => {
    const ok = account(DISTINCT);
    const report = await ok.deploy();
    expect(report.ok).toBe(true);
    expect(ok.probes).toEqual([
      {
        status: 200,
        body: { status: "ok", deployment: "production", plane_id: "flare-dispatch" },
      },
    ]);

    for (const name of [
      "OIDC_SIGNING_JWK",
      "LOG_KEY",
      "COMPILE_CACHE_SECRET",
      "CACHE_TOKEN_SECRET",
      "INSTALL_STATE_KEY",
    ] as const) {
      const clash = account({ ...DISTINCT, [name]: DISTINCT.PROVENANCE_KEY });
      const failed = await clash.deploy();
      expect(failed.ok, name).toBe(false);
      expect(failed.stages.at(-1), name).toMatchObject({ stage: "probes", ok: false });
      expect(failed.stages.at(-1)!.detail).toContain("control-plane: GET /health failed");
      expect(clash.probes, name).toEqual([
        {
          status: 503,
          body: {
            status: "misconfigured",
            path: "PROVENANCE_KEY",
            message: `the provenance key equals ${name}`,
          },
        },
      ]);
      expect(clash.alarms[0]).toMatch(/^deploy-probe-failed: /);
      expect(JSON.stringify(clash.probes)).not.toContain(DISTINCT.PROVENANCE_KEY);
    }
  });
});
