import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  APP_PERMISSIONS,
  DeployTarget,
  deployOrder,
  fdDeploy,
  fdDoctor,
  placeholderOverlay,
  rollbackLine,
  type Deployed,
  type DeployedSettings,
} from "./index.ts";

const template = (name: string, services: string[] = []) => `{
  "name": "${name}",
  "account_id": "{{accountId}}",
  "keep_vars": false,
  "triggers": { "crons": ["* * * * *"] },
  "services": [${services.map((s) => `{ "binding": "${s.toUpperCase()}", "service": "${s}" }`).join(", ")}],
}`;

const WORKERS = [
  { worker: "dispatcher", template: template("dispatcher", ["substrate"]) },
  { worker: "substrate", template: template("substrate") },
];

const settings: DeployedSettings = {
  bindings: [],
  vars: {},
  secrets: [],
  crons: ["* * * * *"],
  routes: [],
  compatibility_date: "2026-05-01",
  compatibility_flags: [],
  containers: [],
};

/** A deploy target that records every call in order. */
const target = (
  opts: { probe?: boolean; canary?: boolean; drifted?: boolean; doMigrations?: string[] } = {},
) => {
  const calls: string[] = [];
  const layer = Layer.succeed(DeployTarget, {
    deployedSettings: (w) =>
      Effect.sync(() => {
        calls.push(`read:${w}`);
        return opts.drifted === true ? { ...settings, vars: { X: "1" } } : settings;
      }),
    lastRecord: (w) => Effect.sync(() => (calls.push(`record?:${w}`), settings)),
    appRegistration: Effect.sync(() => (calls.push("app"), APP_PERMISSIONS)),
    applyD1Migrations: Effect.sync(() => (calls.push("migrate"), ["0007_alarms"])),
    deployWorker: (w) =>
      Effect.sync((): Deployed => {
        calls.push(`deploy:${w}`);
        return {
          worker: w,
          version: `${w}-v2`,
          previousVersion: `${w}-v1`,
          durableObjectMigrations: opts.doMigrations ?? [],
        };
      }),
    probe: (w) => Effect.sync(() => (calls.push(`probe:${w}`), opts.probe ?? true)),
    floorCanary: Effect.sync(() => (calls.push("canary"), opts.canary ?? true)),
    writeRecord: (w) => Effect.sync(() => void calls.push(`write:${w}`)),
    raiseAlarm: (name) => Effect.sync(() => void calls.push(`alarm:${name}`)),
  });
  return { calls, layer };
};

const overlay = JSON.stringify(placeholderOverlay);
const writes = (calls: readonly string[]) =>
  calls.filter((c) => /^(migrate|deploy:|write:|alarm:)/.test(c));

describe("fd deploy", () => {
  it("[FD-OPS-009] runs decode, render, drift, migrations, deploys and probes in order, then records", () => {
    const t = target();
    Effect.runSync(fdDeploy(overlay, WORKERS, APP_PERMISSIONS).pipe(Effect.provide(t.layer)));
    const firstWrite = t.calls.indexOf("migrate");
    expect(t.calls.slice(0, firstWrite).every((c) => /^(read|record\?|app)/.test(c))).toBe(true);
    expect(t.calls.slice(firstWrite)).toEqual([
      "migrate",
      "deploy:substrate",
      "deploy:dispatcher",
      "probe:substrate",
      "probe:dispatcher",
      "canary",
      "write:dispatcher",
      "write:substrate",
    ]);
  });

  it("[FD-OPS-009] [FD-OPS-003] stops at the first failing stage: a bad overlay changes no state", () => {
    const t = target();
    const err = Effect.runSync(
      Effect.flip(
        fdDeploy('{"accountId": "x"}', WORKERS, APP_PERMISSIONS).pipe(Effect.provide(t.layer)),
      ),
    );
    expect(err.stage).toBe("decode");
    expect(t.calls).toEqual([]);
    const drifted = target({ drifted: true });
    const d = Effect.runSync(
      Effect.flip(fdDeploy(overlay, WORKERS, APP_PERMISSIONS).pipe(Effect.provide(drifted.layer))),
    );
    expect(d.stage).toBe("drift");
    expect(writes(drifted.calls)).toEqual([]);
  });

  it("[FD-OPS-010] deploys each Worker after every Worker it binds as a service", () => {
    const order = deployOrder([
      { worker: "a", config: { services: [{ service: "b" }, { service: "external" }] } },
      { worker: "b", config: { services: [{ service: "c" }] } },
      { worker: "c", config: {} },
    ]);
    expect(order).toEqual(["c", "b", "a"]);
  });

  it("[FD-OPS-013] [FD-OPS-014] a failed probe exits non-zero, pages deploy-probe-failed and prints rollback lines, rolling nothing back", () => {
    const t = target({ probe: false });
    const err = Effect.runSync(
      Effect.flip(fdDeploy(overlay, WORKERS, APP_PERMISSIONS).pipe(Effect.provide(t.layer))),
    );
    expect(err.stage).toBe("probes");
    expect(t.calls).toContain("alarm:deploy-probe-failed");
    expect(t.calls.some((c) => c.startsWith("write:"))).toBe(false);
    // D1 migration 0007 ran, so every Worker must fix forward.
    expect(err.rollback).toEqual([
      "substrate: fix forward: rollback blocked by migration 0007_alarms",
      "dispatcher: fix forward: rollback blocked by migration 0007_alarms",
    ]);
    const plain: Deployed = {
      worker: "w",
      version: "v2",
      previousVersion: "v1",
      durableObjectMigrations: [],
    };
    expect(rollbackLine(plain, [])).toBe("wrangler rollback v1 --name w");
    expect(rollbackLine({ ...plain, durableObjectMigrations: ["v3"] }, [])).toBe(
      "w: fix forward: rollback blocked by migration v3",
    );
  });

  it("[FD-OPS-050] the floor canary runs once on the deployed digest and gates success", () => {
    const t = target({ canary: false });
    const err = Effect.runSync(
      Effect.flip(fdDeploy(overlay, WORKERS, APP_PERMISSIONS).pipe(Effect.provide(t.layer))),
    );
    expect(err.stage).toBe("probes");
    expect(t.calls.filter((c) => c === "canary")).toHaveLength(1);
    expect(err.findings).toEqual([
      { path: "floor-canary", detail: "the container floor canary failed on the deployed digest" },
    ]);
  });

  it("[FD-OPS-015] a clean deploy stores each Worker's rendered configuration as the record", () => {
    const t = target();
    Effect.runSync(fdDeploy(overlay, WORKERS, APP_PERMISSIONS).pipe(Effect.provide(t.layer)));
    expect(t.calls.filter((c) => c.startsWith("write:")).sort()).toEqual([
      "write:dispatcher",
      "write:substrate",
    ]);
  });

  it("[FD-OPS-024] [FD-OPS-007] fd doctor runs every drift check through the same renderer and writes nothing", () => {
    const t = target({ drifted: true });
    const findings = Effect.runSync(
      fdDoctor(overlay, WORKERS, APP_PERMISSIONS).pipe(Effect.provide(t.layer)),
    );
    expect(findings.map((f) => f.path)).toEqual(["dispatcher.vars.X", "substrate.vars.X"]);
    expect(writes(t.calls)).toEqual([]);
  });
});
