import { buildProfile, portUses, profile } from "@fractalboxdev/flare-dispatch-profile";
import { missingApplicationPorts } from "@fractalboxdev/mameko-ports";
import { Message } from "@fractalboxdev/mameko-protocol";
import { Schema } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_BINDINGS,
  architectureFindings,
  composedPorts,
  compositionFindings,
  deployedCompositionFindings,
  durableObjectClasses,
  leaseTokenRequestIsReadOnly,
  parseJsonc,
  PRESIGNER_BINDINGS,
  propertyNames,
  requiredPorts,
  secretWireFields,
  SUPPLIED_HERE,
  workflowStarts,
} from "./index.ts";

const complete = {
  durable_objects: {
    bindings: durableObjectClasses(0).map((c) => ({ name: c.toUpperCase(), class_name: c })),
  },
  containers: ["LeanPool", "AgentPool", "BrowserPool", "ReleasePool", "ControlPool"].map(
    (class_name) => ({ class_name }),
  ),
  d1_databases: [{ binding: "DB" }],
  kv_namespaces: [{ binding: "CONFIG_KV" }],
  r2_buckets: [{ binding: "CACHE" }, { binding: "ARTIFACTS" }],
};

describe("components", () => {
  it("[FD-ARCH-001] the dispatcher binds each Durable Object class, a Container class per pool, one D1, KV and the R2 buckets", () => {
    expect(architectureFindings("cp", complete, 0)).toEqual([]);
    expect(durableObjectClasses(4)).toContain("TransparencyLog");
    expect(architectureFindings("cp", complete, 4).map((f) => f.path)).toEqual([
      "cp.durable_objects.TransparencyLog",
    ]);
    const missing = architectureFindings(
      "cp",
      { ...complete, containers: [], kv_namespaces: [] },
      0,
    ).map((f) => f.path);
    expect(missing).toContain("cp.containers.LeanPool");
    expect(missing).toContain("cp.kv_namespaces");
  });

  it("[FD-ARCH-001] finds every component in the committed control-plane template", () => {
    const template = parseJsonc(
      readFileSync(join(import.meta.dirname, "../../../apps/control-plane/wrangler.jsonc"), "utf8"),
    );
    expect(architectureFindings("control-plane", template, 0)).toEqual([]);
  });
});

describe("composition", () => {
  it("[FD-ARCH-039] phase 0 needs a Layer per always-port plus the presigner, and no credential minter while no grant names an application credential", () => {
    expect(requiredPorts(0)).toEqual([
      "actuator",
      "gate-decision-source",
      "configuration-source",
      "alarm-port",
      "actuator-rate-limit",
      "object-store-presigner",
    ]);
    // mameko requires the minter only of a profile whose grants name an application credential.
    for (const deployment of ["production", "development"] as const) {
      expect(portUses(buildProfile(deployment)).applicationCredentials).not.toBe(true);
      for (const phase of [0, 1, 2, 3, 4] as const)
        expect(requiredPorts(phase, deployment)).not.toContain("credential-minter");
    }
    expect(requiredPorts(1, "development")).not.toContain("attestation-verifier");
    expect(requiredPorts(4)).toEqual(
      expect.arrayContaining(["launcher:gha", "result-acceptance-check"]),
    );
    // Every port mameko requires of the phase-0 profile is in the list.
    expect(
      missingApplicationPorts({ launcherKinds: [], attestationVerifier: false }, requiredPorts(0)),
    ).toEqual([]);
    expect(
      missingApplicationPorts(
        { launcherKinds: ["gha"], attestationVerifier: true },
        requiredPorts(4),
      ),
    ).toEqual([]);
  });

  it("[FD-ARCH-039] the composition check names every required port with no Layer", () => {
    expect(Object.keys(SUPPLIED_HERE).sort()).toEqual([
      "alarm-port",
      "configuration-source",
      "gate-decision-source",
    ]);
    expect(compositionFindings(0, Object.keys(SUPPLIED_HERE)).map((f) => f.path)).toEqual([
      "actuator",
      "actuator-rate-limit",
      "object-store-presigner",
    ]);
    expect(compositionFindings(0, requiredPorts(0))).toEqual([]);
  });

  const APP_AND_PRESIGNER = {
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "key",
    R2_ACCOUNT_ID: "acct",
    CACHE_BUCKET_NAME: "fd-cache",
    R2_PRESIGN_ACCESS_KEY_ID: "id",
    R2_PRESIGN_SECRET_ACCESS_KEY: "secret",
  };

  it("[FD-ARCH-039] an env with the App and the presign token composes every port phase 0 requires, and one without either lacks its ports", () => {
    expect(compositionFindings(0, composedPorts(APP_AND_PRESIGNER))).toEqual([]);
    expect(composedPorts(APP_AND_PRESIGNER)).not.toContain("credential-minter");
    for (const name of APP_BINDINGS)
      expect(
        compositionFindings(0, composedPorts({ ...APP_AND_PRESIGNER, [name]: "" })).map(
          (f) => f.path,
        ),
      ).toEqual(["actuator", "actuator-rate-limit"]);
    for (const name of PRESIGNER_BINDINGS)
      expect(
        compositionFindings(0, composedPorts({ ...APP_AND_PRESIGNER, [name]: undefined })).map(
          (f) => f.path,
        ),
      ).toEqual(["object-store-presigner"]);
  });

  it("[FD-ARCH-039] the deploy's composition check reads the rendered vars and the Worker's secret names", () => {
    const config = {
      vars: {
        DEPLOYMENT: "production",
        GITHUB_APP_ID: "1",
        R2_ACCOUNT_ID: "acct",
        CACHE_BUCKET_NAME: "fd-cache",
      },
    };
    const secrets = [
      "GITHUB_APP_PRIVATE_KEY",
      "R2_PRESIGN_ACCESS_KEY_ID",
      "R2_PRESIGN_SECRET_ACCESS_KEY",
    ];
    expect(deployedCompositionFindings("control-plane", config, secrets, 0)).toEqual([]);
    expect(deployedCompositionFindings("control-plane", config, [], 0)).toEqual([
      expect.objectContaining({
        check: "composition",
        path: "control-plane.ports.actuator",
        detail: "phase 0 requires a Layer for actuator; unset: GITHUB_APP_PRIVATE_KEY",
      }),
      expect.objectContaining({ path: "control-plane.ports.actuator-rate-limit" }),
      expect.objectContaining({
        path: "control-plane.ports.object-store-presigner",
        detail:
          "phase 0 requires a Layer for object-store-presigner; unset: R2_PRESIGN_ACCESS_KEY_ID, R2_PRESIGN_SECRET_ACCESS_KEY",
      }),
    ]);
    // Phase 1 adds the attestation verifier, which a production deploy composes no Layer for, and a development one
    // does not need.
    expect(
      deployedCompositionFindings("control-plane", config, secrets, 1).map((f) => f.path),
    ).toEqual(["control-plane.ports.attestation-verifier"]);
    expect(
      deployedCompositionFindings(
        "control-plane",
        { vars: { ...config.vars, DEPLOYMENT: "development" } },
        secrets,
        1,
      ),
    ).toEqual([]);
  });
});

describe("credentials", () => {
  it("[FD-ARCH-005] no executor wire message carries the App key, a provider key, the launcher credential or the provenance key", () => {
    expect(secretWireFields()).toEqual([]);
    // The scan reads the messages' fields, the lease's credentials map included.
    const fields = propertyNames(Message.ast);
    expect(fields.has("execution_id")).toBe(true);
    expect(fields.has("credentials")).toBe(true);
    expect(
      propertyNames(Schema.Struct({ lease: Schema.Struct({ private_key: Schema.String }) }).ast),
    ).toContain("private_key");
    expect(secretWireFields(Schema.Struct({ app_private_key: Schema.String }).ast)).toEqual([
      "app_private_key",
    ]);
  });

  it("[FD-ARCH-004] the one installation token an executor holds is read-only and scoped to one repository", () => {
    const read = {
      metadata: "read",
      contents: "read",
      pull_requests: "read",
      issues: "read",
      checks: "read",
      actions: "read",
    };
    expect(leaseTokenRequestIsReadOnly({ repositories: ["app"], permissions: read })).toBe(true);
    expect(
      leaseTokenRequestIsReadOnly({
        repositories: ["app"],
        permissions: { ...read, contents: "write" },
      }),
    ).toBe(false);
    expect(leaseTokenRequestIsReadOnly({ repositories: ["app", "web"], permissions: read })).toBe(
      false,
    );
    expect(
      leaseTokenRequestIsReadOnly({
        repositories: ["app"],
        permissions: { administration: "read" },
      }),
    ).toBe(false);
  });
});

describe("workflows", () => {
  it("[FD-ARCH-019] release, required and interactive start at admission; batch at its winning claim or stale_at", () => {
    expect(workflowStarts(profile)).toEqual({
      release: "admission",
      required: "admission",
      interactive: "admission",
      batch: "claim-or-stale",
    });
    expect(workflowStarts(buildProfile("production", 4))).toEqual(workflowStarts(profile));
  });
});
