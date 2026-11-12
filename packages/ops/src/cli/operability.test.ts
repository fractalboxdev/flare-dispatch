import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP_PERMISSIONS,
  DeployTarget,
  MERGE_GATE_CHECKS,
  placeholderOverlay,
  type DeployedSettings,
} from "../index.ts";
import { makeOperability, repositoryRoot, V2_WORKERS } from "./index.ts";
import { accessStore } from "../access-application.test-support.ts";

const ROOT = repositoryRoot(import.meta.dirname);
let dir: string;
beforeAll(() => {
  mkdirSync(join(ROOT, ".tmp"), { recursive: true });
  dir = mkdtempSync(join(ROOT, ".tmp", "operability-"));
  mkdirSync(join(dir, "apps/w"), { recursive: true });
  writeFileSync(
    join(dir, "apps/w/wrangler.jsonc"),
    `{ "name": "w", "account_id": "{{accountId}}", "keep_vars": false, "vars": { "ALERT_SINK": "{{alerts.sink}}" }, "triggers": { "crons": ["* * * * *"] } }`,
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const settings: DeployedSettings = {
  bindings: [],
  vars: {},
  secrets: [],
  crons: ["* * * * *"],
  routes: [],
  compatibility_date: "",
  compatibility_flags: [],
  containers: [],
};

const fakeTarget = (calls: string[], opts: { probe?: boolean } = {}) =>
  Layer.succeed(DeployTarget, {
    deployedSettings: () => Effect.succeed(settings),
    lastRecord: () => Effect.succeed(settings),
    appRegistration: Effect.succeed(APP_PERMISSIONS),
    requiredChecks: Effect.succeed([...MERGE_GATE_CHECKS, "flare-dispatch/check:ci"]),
    applyD1Migrations: () => Effect.sync(() => (calls.push("migrate"), [])),
    deployWorker: (r) =>
      Effect.sync(() => {
        calls.push(`deploy:${r.worker}`);
        return {
          worker: r.worker,
          version: "v2",
          previousVersion: "v1",
          durableObjectMigrations: [],
        };
      }),
    probe: () => Effect.succeed(opts.probe ?? true),
    floorCanary: () =>
      Effect.succeed({ status: "not-applicable" as const, detail: "no Container class" }),
    writeRecord: (r) => Effect.sync(() => void calls.push(`record:${r.worker}`)),
    raiseAlarm: (name) => Effect.sync(() => void calls.push(`alarm:${name}`)),
    ...accessStore(),
  });

const service = (calls: string[], opts: { probe?: boolean } = {}) =>
  makeOperability({
    fail: (message) => new Error(message),
    root: dir,
    workers: [{ worker: "w", templatePath: "apps/w/wrangler.jsonc", hostKey: "dispatcher" }],
    target: () => fakeTarget(calls, opts),
  });

const overlay = JSON.stringify(placeholderOverlay);

describe("Operability service", () => {
  it("[FD-IFC-070] [FD-OPS-007] fd deploy runs every stage through the one renderer and reports each in order", async () => {
    const calls: string[] = [];
    const report = await Effect.runPromise(service(calls).deploy({ overlay, dryRun: false }));
    expect(report.ok).toBe(true);
    expect(report.stages.map((s) => [s.stage, s.ok])).toEqual([
      ["decode", true],
      ["render", true],
      ["drift", true],
      ["migrations", true],
      ["deploy", true],
      ["probes", true],
      ["record", true],
    ]);
    expect(calls).toEqual(["migrate", "deploy:w", "record:w"]);
  });

  it("[FD-OPS-003] [FD-OPS-004] an overlay with an undeclared key or a missing value stops at decode with no state changed", async () => {
    const calls: string[] = [];
    const report = await Effect.runPromise(
      service(calls).deploy({
        overlay: JSON.stringify({ ...placeholderOverlay, extra: 1 }),
        dryRun: false,
      }),
    );
    expect(report.ok).toBe(false);
    expect(report.stages).toEqual([
      { stage: "decode", ok: false, detail: expect.stringContaining("extra") },
    ]);
    expect(calls).toEqual([]);
  });

  it("[FD-OPS-024] fd doctor and fd deploy --dry-run stop after the drift check and change nothing", async () => {
    const calls: string[] = [];
    const doctor = await Effect.runPromise(service(calls).doctor(overlay));
    const dry = await Effect.runPromise(service(calls).deploy({ overlay, dryRun: true }));
    expect(doctor).toEqual(dry);
    expect(doctor.stages.map((s) => s.stage)).toEqual(["decode", "render", "drift"]);
    expect(calls).toEqual([]);
  });

  it("[FD-OPS-013] a failed probe reports the probes stage with the rollback line and pages deploy-probe-failed", async () => {
    const calls: string[] = [];
    const report = await Effect.runPromise(
      service(calls, { probe: false }).deploy({ overlay, dryRun: false }),
    );
    expect(report.ok).toBe(false);
    const probes = report.stages.at(-1)!;
    expect(probes).toMatchObject({ stage: "probes", ok: false });
    expect(probes.detail).toContain("wrangler rollback v1 --name w");
    expect(calls).toContain("alarm:deploy-probe-failed");
    expect(calls.some((c) => c.startsWith("record:"))).toBe(false);
  });

  it("[FD-OPS-021] the committed templates' drift check carries mameko's profile validator and the components check", async () => {
    expect(V2_WORKERS.map((w) => w.worker)).toEqual(["control-plane", "docs"]);
    const calls: string[] = [];
    const live = makeOperability({
      fail: (m) => new Error(m),
      root: ROOT,
      target: () => fakeTarget(calls),
    });
    const report = await Effect.runPromise(live.doctor(overlay));
    const drift = report.stages.find((s) => s.stage === "drift")!;
    // The control-plane template passes every check; the documentation Worker's template still fails its own.
    expect(drift.ok).toBe(false);
    expect(drift.detail).not.toContain("control-plane.");
    expect(drift.detail).toContain("docs.keep_vars");
  });
});
