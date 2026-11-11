// The deploy suites of `V-DEPLOY` for the drift check (specs/operability.md § Drift check): the checks the
// `deploy-dry-run` job runs over the rendered control-plane template and the production profile (`staticDrift`,
// `profileDriftFindings`), and the drift stage of `fd deploy` on the fakes of `support.ts`.
import {
  buildProfile,
  missingPorts,
  poolAdmissionCaps,
  profileDocumentFor,
} from "@fractalboxdev/flare-dispatch-profile";
import { AlarmPort } from "@fractalboxdev/mameko-ports";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Effect } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sqliteDb } from "../../src/d1.test-support.ts";
import {
  activeAlarms,
  alarmPortFromEnv,
  APP_PERMISSIONS,
  containerClassOf,
  placeholderOverlay,
  requiredPorts,
} from "../../src/index.ts";
import { profileDriftFindings, staticDrift, type WorkerSpec } from "../../src/cli/index.ts";
import { CONTROL_PLANE, deploy, fd, isWrite, OVERLAY, ROOT, SCRIPT, world } from "./support.ts";

const TEMPLATE = readFileSync(join(ROOT, CONTROL_PLANE.templatePath), "utf8");

/** The committed template with one edit, which must apply. */
const edited = (from: string | RegExp, to: string): string => {
  const text = TEMPLATE.replace(from, to);
  expect(text).not.toBe(TEMPLATE);
  return text;
};

/** The committed template with one Container class's `max_instances` set to `max`. */
const withMax = (cls: string, max: number): string =>
  edited(new RegExp(`("class_name": "${cls}",[^}]*?"max_instances": )\\d+`), `$1${max}`);

let dir: string;
let n = 0;
/** The dispatcher deployed from `template`, written beside the committed templates. */
const dispatcherFrom = (template: string): WorkerSpec => {
  const path = join(dir, `control-plane-${++n}.jsonc`);
  writeFileSync(path, template);
  return { ...CONTROL_PLANE, templatePath: relative(ROOT, path) };
};

const staticFindings = (template: string) =>
  Effect.runSync(staticDrift(CONTROL_PLANE, template, placeholderOverlay)).findings;

const driftStage = (report: {
  readonly stages: readonly { stage: string; ok: boolean; detail: string }[];
}) => report.stages.find((s) => s.stage === "drift");

beforeAll(() => {
  mkdirSync(join(ROOT, ".tmp"), { recursive: true });
  dir = mkdtempSync(join(ROOT, ".tmp", "drift-harness-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

describe("the drift check over the rendered control-plane template", () => {
  it("[FD-OPS-019] fails a deploy whose rendered configuration lacks a binding the control plane's environment schema declares, naming the binding", async () => {
    expect(staticFindings(TEMPLATE)).toEqual([]);

    for (const binding of ["PLANE_ID", "DEPLOYMENT"]) {
      const template = edited(new RegExp(`\\n\\s*"${binding}": "[^"]*",`), "");
      expect(staticFindings(template)).toEqual([
        {
          check: "binding",
          path: `control-plane.${binding}`,
          detail: `binding ${binding} is absent`,
          severity: "failure",
        },
      ]);

      const w = world();
      const report = await deploy(w, OVERLAY, { workers: [dispatcherFrom(template)] });
      expect(report.ok).toBe(false);
      expect(report.stages.at(-1)).toEqual({
        stage: "drift",
        ok: false,
        detail: `control-plane.${binding}: binding ${binding} is absent`,
      });
      expect(w.calls.filter(isWrite)).toEqual([]);
    }
  });

  it("[FD-OPS-020] [FD-PROF-033] fails a deploy in which a pool's admission cap is at or above its Container class's max_instances, naming the pool", async () => {
    expect(poolAdmissionCaps).toEqual({
      lean: { admission_cap: 48 },
      agent: { admission_cap: 8 },
      browser: { admission_cap: 16 },
      release: { admission_cap: 8 },
      control: { admission_cap: 16 },
    });

    for (const [pool, { admission_cap: cap }] of Object.entries(poolAdmissionCaps)) {
      const cls = containerClassOf(pool);
      // One above the cap passes; at the cap and below it fail.
      expect(staticFindings(withMax(cls, cap + 1))).toEqual([]);
      for (const max of [cap, cap - 1])
        expect(staticFindings(withMax(cls, max))).toEqual([
          {
            check: "admission-cap",
            path: `control-plane.containers.${cls}.max_instances`,
            detail: `pool ${pool}: admission cap ${cap} is not below max_instances ${max}`,
            severity: "failure",
          },
        ]);

      const w = world();
      const report = await deploy(w, OVERLAY, { workers: [dispatcherFrom(withMax(cls, cap))] });
      expect(report.ok).toBe(false);
      expect(report.stages.at(-1)).toEqual({
        stage: "drift",
        ok: false,
        detail: `control-plane.containers.${cls}.max_instances: pool ${pool}: admission cap ${cap} is not below max_instances ${cap}`,
      });
      expect(w.calls.filter(isWrite)).toEqual([]);
    }
  });
});

describe("the drift check over the GitHub App's registration", () => {
  const { default_permissions: perms, default_events: events } = APP_PERMISSIONS;

  it("[FD-OPS-022] reads the App registration from the GitHub API and fails on a missing permission, a lower access level or a missing manifest event", async () => {
    const { merge_queues: _dropped, ...lacking } = perms;
    const cases = [
      {
        app: { default_permissions: lacking, default_events: events },
        line: "permissions.merge_queues: manifest read, registered absent",
      },
      {
        app: { default_permissions: { ...perms, checks: "read" as const }, default_events: events },
        line: "permissions.checks: manifest write, registered read",
      },
      {
        app: {
          default_permissions: perms,
          default_events: events.filter((e) => e !== "merge_group"),
        },
        line: "events.merge_group: a manifest event the registration does not subscribe to",
      },
    ];
    for (const { app, line } of cases) {
      const w = world();
      w.state.app = app;
      const report = await deploy(w);
      expect(report.ok).toBe(false);
      expect(report.stages.at(-1)).toEqual({ stage: "drift", ok: false, detail: line });
      expect(w.calls).toContain("GET api.github.com/app");
      expect(w.calls.filter(isWrite)).toEqual([]);

      const doctor = await Effect.runPromise(fd(w).doctor(OVERLAY));
      expect(driftStage(doctor)).toEqual({ stage: "drift", ok: false, detail: `failure ${line}` });
    }

    // A higher access level than the manifest's is no drift.
    const w = world();
    w.state.app = { default_permissions: { ...perms, metadata: "write" }, default_events: events };
    expect((await deploy(w)).ok).toBe(true);
  });

  it("[FD-OPS-023] reports an event the registration subscribes to and the manifest does not list as a warning, and the deploy continues", async () => {
    const w = world();
    w.state.app = { default_permissions: perms, default_events: [...events, "star"] };
    const line = "events.star: the registration subscribes to an event the manifest does not list";

    const report = await deploy(w);
    expect(report.ok).toBe(true);
    expect(driftStage(report)).toEqual({ stage: "drift", ok: true, detail: `warning ${line}` });
    expect(w.calls).toContain(`wrangler deploy ${SCRIPT}`);

    const doctor = await Effect.runPromise(fd(w).doctor(OVERLAY));
    expect(doctor.ok).toBe(true);
    expect(driftStage(doctor)).toEqual({ stage: "drift", ok: true, detail: `warning ${line}` });
  });
});

describe("the alert sink", () => {
  it("[FD-OPS-053] the deployed control plane's alarm port records each alarm for the dashboard and sends it to the overlay's sink; no deploy goes out without either", async () => {
    const w = world();
    expect((await deploy(w)).ok).toBe(true);
    const sink = w.scripts.get(SCRIPT)!.bindings.find((b) => b["name"] === "ALERT_SINK");
    expect(sink).toEqual({
      type: "plain_text",
      name: "ALERT_SINK",
      text: placeholderOverlay.alerts.sink,
    });

    // The alarm port over the deployed Worker's env.
    vi.stubGlobal("fetch", w.fetcher);
    const t = await sqliteDb();
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* (yield* AlarmPort).deliver({
            name: "drift",
            severity: "notify",
            dedupeKey: "drift",
            state: "raised",
            detail: null,
          });
        }).pipe(
          Effect.provide(alarmPortFromEnv({ DB: t.db, ALERT_SINK: sink!["text"] as string })),
        ),
      );
      expect((await activeAlarms(t.db)).map((a) => a.name)).toEqual(["drift"]);
    } finally {
      await t.dispose();
    }
    expect(w.alarms).toEqual([
      expect.objectContaining({ alarm: "drift", severity: "notify", state: "raised" }),
    ]);

    // A template that renders no sink fails the drift check, so nothing deploys.
    const without = world();
    const template = edited(/\n\s*"ALERT_SINK": "\{\{alerts\.sink\}\}",/, "");
    const report = await deploy(without, OVERLAY, { workers: [dispatcherFrom(template)] });
    expect(report.stages.at(-1)).toEqual({
      stage: "drift",
      ok: false,
      detail: "control-plane.ALERT_SINK: binding ALERT_SINK is absent",
    });
    expect(without.calls.filter(isWrite)).toEqual([]);

    // A composition without the alarm port fails mameko's configuration validation of the phase 0 profile.
    const withoutPort = requiredPorts(0).filter((p) => p !== "alarm-port");
    expect(missingPorts(buildProfile("production"), withoutPort)).toEqual(["alarm-port"]);
  });

  it("[FD-OPS-056] fd deploy rejects an overlay that names no alert sink, before any Cloudflare call", async () => {
    const { alerts: _alerts, ...noAlerts } = placeholderOverlay;
    for (const overlay of [
      { ...placeholderOverlay, alerts: {} },
      { ...placeholderOverlay, alerts: { sink: "" } },
      noAlerts,
    ]) {
      const w = world();
      const report = await deploy(w, JSON.stringify(overlay));
      expect(report.ok).toBe(false);
      expect(report.stages).toEqual([
        { stage: "decode", ok: false, detail: expect.stringContaining("alerts") },
      ]);
      expect(w.calls).toEqual([]);
      expect(w.runs).toEqual([]);
    }
  });
});

describe("the drift check over the production profile", () => {
  it("[FD-PROF-064] passes the phase 0 production profile and fails a document that lists aws or gha, registers a launcher, declares a constraint or sets attestation before its phase", () => {
    const committed = buildProfile("production");
    expect(Effect.runSync(profileDriftFindings())).toEqual([]);
    expect(Effect.runSync(profileDriftFindings(profileDocumentFor("production", 0)))).toEqual([]);
    for (const c of committed.classes) expect(c.cloud_kinds).toEqual(["cloudflare"]);
    expect(committed.placement.launcher_kinds).toEqual([]);
    expect(committed.placement.constraints).toEqual([]);
    expect(committed.registration.attestation).toBe("none");

    // Each phase's document under its own policy version.
    const versions = ([0, 1, 2, 3, 4] as const).map(
      (p) => profileDocumentFor("production", p).policyVersion,
    );
    expect(new Set(versions).size).toBe(5);

    const pathsAt = (phase: 1 | 3 | 4) =>
      Effect.runSync(profileDriftFindings(profileDocumentFor("production", phase))).map(
        (f) => f.path,
      );
    expect(pathsAt(1)).toContain("registration.attestation");
    expect(pathsAt(3)).toEqual(
      expect.arrayContaining(["registration.attestation", "classes[required].cloud_kinds"]),
    );
    const phase4 = pathsAt(4);
    for (const c of committed.classes) expect(phase4).toContain(`classes[${c.name}].cloud_kinds`);
    expect(phase4).toEqual(
      expect.arrayContaining(["placement.launcher_kinds", "placement.constraints"]),
    );
  });
});
