// The deploy suite of `V-DEPLOY` (specs/verification.md § Harness catalog) for the dispatcher's composition
// (specs/architecture.md § Composition): `fd deploy` over the committed control-plane template and the placeholder
// overlay checks, in its drift stage, that the rendered vars and the Worker secrets the account holds compose a Layer
// for every application port the current phase requires, by the same port list the Worker reads.
import {
  APP_PERMISSIONS,
  compositionFindings,
  DeployTarget,
  deployedCompositionFindings,
  MERGE_GATE_CHECKS,
  parseJsonc,
  placeholderOverlay,
  renderedEnv,
  renderTemplate,
  TargetFailed,
  type DeployedSettings,
} from "@fractalboxdev/flare-dispatch-ops";
import { makeOperability, repositoryRoot, V2_WORKERS } from "@fractalboxdev/flare-dispatch-ops/cli";
import { buildProfile, CURRENT_PHASE, missingPorts } from "@fractalboxdev/flare-dispatch-profile";
import { Effect, Layer } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ControlPlaneEnv } from "../../src/config.ts";
import { suppliedPorts } from "../../src/ports.ts";

const ROOT = repositoryRoot(import.meta.dirname);
const OVERLAY = JSON.stringify(placeholderOverlay);
const CONTROL_PLANE = V2_WORKERS.find((w) => w.worker === "control-plane")!;

/** The Worker secrets the composition reads: the App key and the presign token. */
const SECRETS = [
  "GITHUB_APP_PRIVATE_KEY",
  "R2_PRESIGN_ACCESS_KEY_ID",
  "R2_PRESIGN_SECRET_ACCESS_KEY",
];

const settingsWith = (secrets: readonly string[]): DeployedSettings => ({
  bindings: [],
  vars: {},
  secrets,
  crons: [],
  routes: [],
  compatibility_date: "",
  compatibility_flags: [],
  containers: [],
});

/** An account whose control-plane Worker holds `secrets`, or no Worker at all for `null`; it records every write. */
const account = (secrets: readonly string[] | null) => {
  const writes: string[] = [];
  const target = Layer.succeed(DeployTarget, {
    deployedSettings: () => Effect.succeed(secrets === null ? null : settingsWith(secrets)),
    lastRecord: () => Effect.succeed(null),
    appRegistration: Effect.succeed(APP_PERMISSIONS),
    requiredChecks: Effect.succeed([...MERGE_GATE_CHECKS, "flare-dispatch/check:ci"]),
    awsBudgets: Effect.fail(
      new TargetFailed({ operation: "aws budgets", message: "the account has no AWS budgets" }),
    ),
    runnerWorkflow: () => Effect.succeed(null),
    applyD1Migrations: () => Effect.sync(() => (writes.push("migrations"), [])),
    deployWorker: (r) =>
      Effect.sync(() => {
        writes.push(`deploy ${r.worker}`);
        return {
          worker: r.worker,
          version: "v1",
          previousVersion: null,
          durableObjectMigrations: [],
        };
      }),
    probe: () => Effect.succeed(true),
    floorCanary: () => Effect.succeed({ status: "passed" as const, digest: "sha256:0" }),
    writeRecord: (r) => Effect.sync(() => void writes.push(`record ${r.worker}`)),
    raiseAlarm: (name) => Effect.sync(() => void writes.push(`alarm ${name}`)),
    accessApplications: Effect.succeed([]),
    putAccessApplication: () => Effect.sync(() => void writes.push("access")),
    deleteAccessApplication: () => Effect.sync(() => void writes.push("access")),
  });
  const fd = makeOperability({
    fail: (message) => new Error(message),
    root: ROOT,
    workers: [CONTROL_PLANE],
    target: () => target,
  });
  return {
    writes,
    deploy: () => Effect.runPromise(fd.deploy({ overlay: OVERLAY, dryRun: false })),
    doctor: () => Effect.runPromise(fd.doctor(OVERLAY)),
  };
};

const rendered = async () =>
  parseJsonc(
    await Effect.runPromise(
      renderTemplate(
        "control-plane",
        readFileSync(join(ROOT, CONTROL_PLANE.templatePath), "utf8"),
        placeholderOverlay,
      ),
    ),
  );

describe("fd deploy against the dispatcher's composition", () => {
  it("[FD-ARCH-039] an account holding the App key and the presign token deploys, and one missing either stops in the drift stage before its first write, naming each port with no Layer", async () => {
    const ok = account(SECRETS);
    const report = await ok.deploy();
    expect(report.ok).toBe(true);
    expect(ok.writes).toContain("deploy control-plane");

    const cases: readonly [readonly string[] | null, readonly string[]][] = [
      [
        ["R2_PRESIGN_ACCESS_KEY_ID", "R2_PRESIGN_SECRET_ACCESS_KEY"],
        ["actuator", "actuator-rate-limit"],
      ],
      [["GITHUB_APP_PRIVATE_KEY", "R2_PRESIGN_SECRET_ACCESS_KEY"], ["object-store-presigner"]],
      [["GITHUB_APP_PRIVATE_KEY", "R2_PRESIGN_ACCESS_KEY_ID"], ["object-store-presigner"]],
      // A Worker the account has never held has no secrets.
      [null, ["actuator", "actuator-rate-limit", "object-store-presigner"]],
    ];
    for (const [secrets, ports] of cases) {
      const short = account(secrets);
      const failed = await short.deploy();
      expect(failed.ok).toBe(false);
      const drift = failed.stages.find((s) => s.stage === "drift")!;
      expect(drift.ok).toBe(false);
      const named = [...drift.detail.matchAll(/control-plane\.ports\.([\w:-]+?): /g)].map(
        (m) => m[1],
      );
      expect(named).toEqual(ports);
      expect(short.writes).toEqual([]);
      // `fd doctor` runs the same check.
      const doctor = await short.doctor();
      expect(doctor.ok).toBe(false);
      expect(doctor.stages.at(-1)!.detail).toContain(`control-plane.ports.${ports[0]}`);
    }
  });

  it("[FD-ARCH-039] the deploy check reads the port list the Worker composes from the same env, and that list carries every port the phase profile uses", async () => {
    const config = await rendered();
    for (const secrets of [SECRETS, [], ["GITHUB_APP_PRIVATE_KEY"]]) {
      const env = renderedEnv(config, secrets) as unknown as ControlPlaneEnv;
      expect(
        deployedCompositionFindings("control-plane", config, secrets, CURRENT_PHASE).map(
          (f) => f.path,
        ),
      ).toEqual(
        compositionFindings(CURRENT_PHASE, suppliedPorts(env)).map(
          (f) => `control-plane.ports.${f.path}`,
        ),
      );
    }
    const full = suppliedPorts(renderedEnv(config, SECRETS) as unknown as ControlPlaneEnv);
    expect(compositionFindings(CURRENT_PHASE, full)).toEqual([]);
    expect(missingPorts(buildProfile("production"), full)).toEqual([]);
  });
});
