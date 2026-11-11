import { profileDocumentFor } from "@fractalboxdev/flare-dispatch-profile";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  admissionCapCheck,
  APP_PERMISSIONS,
  appManifest,
  appRegistrationCheck,
  bindingCheck,
  failed,
  MERGE_GATE_CHECKS,
  profileCheck,
  rulesetCheck,
  settingsDrift,
  type DeployedSettings,
} from "./index.ts";
import { validationContext } from "@fractalboxdev/flare-dispatch-profile";

const settings: DeployedSettings = {
  bindings: [
    { name: "DB", type: "d1", target: "db-id" },
    { name: "CHANNEL", type: "durable_object_namespace", target: "ExecutorChannel" },
  ],
  vars: { DEPLOYMENT: "production" },
  secrets: ["GITHUB_APP_PRIVATE_KEY"],
  crons: ["* * * * *"],
  routes: ["dispatch.example.com"],
  compatibility_date: "2026-05-01",
  compatibility_flags: [],
  containers: [{ class_name: "LeanPool", max_instances: 64, image: "sha256:abc" }],
};

const containers = (max: Record<string, number>) => ({
  containers: Object.entries(max).map(([pool, n]) => ({
    class_name: `${pool.charAt(0).toUpperCase()}${pool.slice(1)}Pool`,
    max_instances: n,
  })),
});

describe("drift check", () => {
  it("[FD-OPS-016] [FD-OPS-017] each deployed setting that differs from the record fails with both values", () => {
    expect(settingsDrift("cp", settings, settings)).toEqual([]);
    const deployed: DeployedSettings = {
      ...settings,
      vars: { DEPLOYMENT: "development" },
      crons: ["*/5 * * * *"],
      containers: [{ class_name: "LeanPool", max_instances: 32, image: "sha256:abc" }],
    };
    const findings = settingsDrift("cp", settings, deployed);
    expect(findings.map((f) => f.path)).toEqual([
      "cp.vars.DEPLOYMENT",
      "cp.crons",
      "cp.containers.LeanPool",
    ]);
    expect(findings[0]!.detail).toBe('deployed "development", recorded "production"');
  });

  it("[FD-OPS-017] a secret shows by name only, never a value", () => {
    const findings = settingsDrift("cp", settings, {
      ...settings,
      secrets: ["GITHUB_APP_PRIVATE_KEY", "LINK_KEY"],
    });
    expect(findings).toEqual([
      {
        check: "settings",
        path: "cp.secrets.LINK_KEY",
        detail: "secret LINK_KEY present on the deployed Worker, absent in the record",
        severity: "failure",
      },
    ]);
  });

  it("[FD-OPS-019] a binding the environment schema declares and the rendered configuration lacks fails, named", () => {
    const rendered = {
      d1_databases: [{ binding: "DB" }],
      durable_objects: { bindings: [{ name: "CHANNEL" }] },
      vars: { PLANE_ID: "x" },
    };
    expect(bindingCheck("cp", rendered, ["DB", "CHANNEL", "PLANE_ID"])).toEqual([]);
    expect(bindingCheck("cp", rendered, ["DB", "MONITOR"]).map((f) => f.path)).toEqual([
      "cp.MONITOR",
    ]);
  });

  it("[FD-OPS-020] [FD-PROF-033] a pool whose admission cap is not below its Container class's max_instances fails", () => {
    const ok = containers({ lean: 49, agent: 9, browser: 17, release: 9, control: 17 });
    expect(admissionCapCheck("cp", ok)).toEqual([]);
    const equal = containers({ lean: 48, agent: 9, browser: 17, release: 9, control: 17 });
    expect(admissionCapCheck("cp", equal).map((f) => f.path)).toEqual([
      "cp.containers.LeanPool.max_instances",
    ]);
    expect(admissionCapCheck("cp", {}).map((f) => f.detail)).toContain(
      "pool lean has no Container class LeanPool",
    );
  });

  it("[FD-OPS-021] mameko's profile validator rejections fail the check, every one listed", () => {
    expect(
      Effect.runSync(profileCheck(profileDocumentFor("production"), validationContext)),
    ).toEqual([]);
    const doc = profileDocumentFor("production");
    const broken = {
      ...doc,
      document: {
        ...(doc.document as object),
        gate_policy: { keys: ["x"], max_expiry_seconds: 0 },
      },
    };
    const findings = Effect.runSync(profileCheck(broken, validationContext));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.check === "profile")).toBe(true);
  });

  it("[FD-OPS-022] a registration lacking a permission, at a lower level, or lacking a manifest event fails", () => {
    expect(appRegistrationCheck(APP_PERMISSIONS, APP_PERMISSIONS)).toEqual([]);
    const noAdmin = Object.fromEntries(
      Object.entries(APP_PERMISSIONS.default_permissions)
        .filter(([p]) => p !== "administration")
        .map(([p, level]) => [p, p === "checks" ? ("read" as const) : level]),
    );
    const findings = appRegistrationCheck(APP_PERMISSIONS, {
      default_permissions: noAdmin,
      default_events: APP_PERMISSIONS.default_events.filter((e) => e !== "merge_group"),
    });
    expect(findings.map((f) => f.path)).toEqual([
      "permissions.checks",
      "permissions.administration",
      "events.merge_group",
    ]);
    expect(failed(findings)).toBe(true);
  });

  it("[FD-OPS-023] an extra subscribed event warns and does not fail the check", () => {
    const extra = {
      ...APP_PERMISSIONS,
      default_events: [...APP_PERMISSIONS.default_events, "star"],
    };
    const findings = appRegistrationCheck(APP_PERMISSIONS, extra);
    expect(findings).toEqual([
      expect.objectContaining({ path: "events.star", severity: "warning" }),
    ]);
    expect(failed(findings)).toBe(false);
  });

  it("[FD-VER-023] [FD-OPS-028] the drift check fails when the ruleset lacks a merge-gate check", () => {
    expect(rulesetCheck([...MERGE_GATE_CHECKS, "flare-dispatch/check:ci"])).toEqual([]);
    expect(
      rulesetCheck(MERGE_GATE_CHECKS.filter((c) => c !== "formal")).map((f) => f.path),
    ).toEqual(["required_status_checks.formal", "required_status_checks.flare-dispatch/check:ci"]);
  });

  it("[FD-OPS-029] the App asks administration at read, below the write a ruleset change needs", () => {
    // GitHub refuses a ruleset create, update or delete to an installation without `administration: write`.
    for (const { default_permissions } of [APP_PERMISSIONS, appManifest("https://cp.example")]) {
      expect(default_permissions.administration).toBe("read");
      expect(Object.values(default_permissions)).not.toContain("admin");
    }
  });
});
