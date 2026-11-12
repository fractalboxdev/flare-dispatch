// The deploy suites of `V-DEPLOY` for the drift check (specs/operability.md § Drift check): the checks the
// `deploy-dry-run` job runs over the rendered control-plane template and the production profile (`staticDrift`,
// `profileDriftFindings`), and the drift stage of `fd deploy` on the fakes of `support.ts`.
import {
  buildProfile,
  loadProfile,
  missingPorts,
  poolAdmissionCaps,
  profileDocumentFor,
  profileLoader,
  spendDefaults,
  validationContext,
} from "@fractalboxdev/flare-dispatch-profile";
import { AlarmPort, type ProfileDocument } from "@fractalboxdev/mameko-ports";
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
import {
  CONTROL_PLANE,
  deploy,
  fd,
  isWrite,
  OVERLAY,
  ROOT,
  SCRIPT,
  withRescan,
  world,
} from "./support.ts";

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
  it("[FD-OPS-021] fd deploy and fd doctor fail a deploy whose profile document the profile validator rejects, listing every rejection the validator returns, before any Cloudflare write", async () => {
    // The production document is accepted, and the deploy that carries it goes out.
    const accepted = world();
    expect(
      (await deploy(accepted, OVERLAY, { profile: profileDocumentFor("production") })).ok,
    ).toBe(true);

    const production = profileDocumentFor("production");
    const documents: ProfileDocument[] = [
      // Later phases' documents: validation rejections, several at once.
      profileDocumentFor("production", 1),
      profileDocumentFor("production", 4),
      // A section that does not decode: one rejection with an empty path, named by its item.
      { ...production, document: { ...(production.document as object), placement: null } },
      // An envelope whose policy version is not the document's.
      { ...production, policyVersion: "flare-dispatch.v2.other" },
    ];
    for (const document of documents) {
      const rejections = Effect.runSync(
        Effect.flip(loadProfile(profileLoader(validationContext), document)),
      ).rejections;
      expect(rejections.length).toBeGreaterThan(0);
      const lines = rejections.map((r) => `${r.path === "" ? r.item : r.path}: ${r.reason}`);

      const w = world();
      const report = await deploy(w, OVERLAY, { profile: document });
      expect(report.ok).toBe(false);
      expect(report.stages.at(-1)).toEqual({
        stage: "drift",
        ok: false,
        detail: lines.join("\n"),
      });
      expect(w.calls.filter(isWrite)).toEqual([]);
      expect(w.runs).toEqual([]);

      const doctor = await Effect.runPromise(fd(w, { profile: document }).doctor(OVERLAY));
      expect(doctor.ok).toBe(false);
      expect(driftStage(doctor)).toEqual({
        stage: "drift",
        ok: false,
        detail: lines.map((l) => `failure ${l}`).join("\n"),
      });
    }
    // The phase 4 document carries more than one rejection, and every one reaches the report.
    expect(
      Effect.runSync(
        Effect.flip(
          loadProfile(profileLoader(validationContext), profileDocumentFor("production", 4)),
        ),
      ).rejections.length,
    ).toBeGreaterThan(3);
  });

  it("[FD-PROF-064] passes the phase 0 production profile and fails a document that lists aws or gha, registers a launcher, declares a constraint or sets attestation before its phase", () => {
    const committed = buildProfile("production");
    expect(
      Effect.runSync(profileDriftFindings(profileDocumentFor("production"), spendDefaults)),
    ).toEqual([]);
    expect(
      Effect.runSync(profileDriftFindings(profileDocumentFor("production", 0), spendDefaults)),
    ).toEqual([]);
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
      Effect.runSync(
        profileDriftFindings(profileDocumentFor("production", phase), spendDefaults),
      ).map((f) => f.path);
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

/** The placeholder overlay with operators, dispatchers and containment identities, and `scoped` entries. */
const identityOverlay = (
  scoped: readonly Record<string, unknown>[],
  lists: { operators?: string[]; dispatchers?: string[]; containment?: string[] } = {},
) =>
  JSON.stringify({
    ...placeholderOverlay,
    operators: lists.operators ?? ["operator@example.com"],
    dispatchers: lists.dispatchers ?? ["dispatcher@example.com"],
    containment: lists.containment ?? ["responder@example.com"],
    dispatch: { scoped },
  });
const entry = (identity: string, over: Record<string, unknown> = {}) => ({
  identity,
  runs: ["security-rescan"],
  repositories: ["acme/app"],
  classCeiling: "batch",
  ...over,
});

/** `fd deploy` over `overlay` with `security-rescan` a read-only scan run: its report and whether it wrote. */
const deployIdentities = async (overlay: string) => {
  const w = world();
  const report = await deploy(w, overlay, { runRegistry: withRescan() });
  return { report, wrote: w.calls.filter(isWrite).length > 0 };
};

/** Asserts `fd deploy` stopped at the drift stage, before any write, with each of `lines` in its detail. */
const expectDriftFailure = async (overlay: string, lines: readonly string[]) => {
  const { report, wrote } = await deployIdentities(overlay);
  expect(report.ok).toBe(false);
  expect(report.stages.at(-1)).toMatchObject({ stage: "drift", ok: false });
  for (const line of lines) expect(report.stages.at(-1)?.detail).toContain(line);
  expect(wrote).toBe(false);
};

describe("the drift stage over the overlay's scoped and containment identities", () => {
  it("[FD-OPS-090] fd deploy fails before any write when a dispatch.scoped identity is also in dispatchers, operators or containment, naming the identity", async () => {
    const clean = await deployIdentities(identityOverlay([entry("scanner@example.com")]));
    expect(clean.report.ok).toBe(true);
    expect(clean.report.stages.find((s) => s.stage === "drift")?.detail ?? "").not.toContain(
      "dispatch.scoped",
    );

    for (const [identity, list] of [
      ["dispatcher@example.com", "dispatchers"],
      ["operator@example.com", "operators"],
      ["responder@example.com", "containment"],
    ] as const)
      await expectDriftFailure(identityOverlay([entry(identity)]), [
        `dispatch.scoped.0.identity: ${identity} is also in ${list}`,
      ]);

    const checked = await Effect.runPromise(
      fd(world(), { runRegistry: withRescan() }).doctor(
        identityOverlay([entry("operator@example.com")]),
      ),
    );
    expect(checked.ok).toBe(false);
    expect(checked.stages.find((s) => s.stage === "drift")?.detail).toContain(
      "operator@example.com is also in operators",
    );
  });

  it("[FD-OPS-091] fd deploy fails before any write when a dispatch.scoped entry names a run that is not a read-only scan run, naming the run", async () => {
    await expectDriftFailure(
      identityOverlay([
        entry("scanner@example.com", { runs: ["security-rescan", "worker-deploy"] }),
      ]),
      ["dispatch.scoped.0.runs: run worker-deploy is not a read-only scan run"],
    );
    // The committed catalogue holds no read-only scan run, so a scoped entry naming one it lacks fails.
    const w = world();
    const report = await deploy(w, identityOverlay([entry("scanner@example.com")]));
    expect(report.ok).toBe(false);
    expect(report.stages.at(-1)?.detail).toContain(
      "dispatch.scoped.0.runs: run security-rescan is not a read-only scan run",
    );
    expect(w.calls.filter(isWrite)).toEqual([]);
  });

  it("[FD-OPS-092] fd deploy fails before any write when a dispatch.scoped entry's classCeiling is neither interactive nor batch, naming the identity", async () => {
    const interactive = await deployIdentities(
      identityOverlay([entry("scanner@example.com", { classCeiling: "interactive" })]),
    );
    expect(interactive.report.ok).toBe(true);
    for (const ceiling of ["required", "release"])
      await expectDriftFailure(
        identityOverlay([entry("scanner@example.com", { classCeiling: ceiling })]),
        [
          `dispatch.scoped.0.classCeiling: scanner@example.com: classCeiling ${ceiling} is neither interactive nor batch`,
        ],
      );
  });

  it("[FD-OPS-093] fd deploy fails before any write when a containment identity is also in operators or dispatchers, naming the identity", async () => {
    for (const [identity, list] of [
      ["operator@example.com", "operators"],
      ["dispatcher@example.com", "dispatchers"],
    ] as const)
      await expectDriftFailure(
        identityOverlay([], { containment: ["responder@example.com", identity] }),
        [`containment.1: ${identity} is also in ${list}`],
      );
    const clean = await deployIdentities(identityOverlay([]));
    expect(clean.report.ok).toBe(true);
  });
});
