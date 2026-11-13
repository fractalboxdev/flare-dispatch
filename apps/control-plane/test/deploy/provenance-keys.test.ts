// The deploy suite of `V-DEPLOY` (specs/verification.md § Harness catalog) for the control plane's key distinctness
// (specs/provenance.md § Keys): `fd deploy` over the committed control-plane template and the placeholder overlay,
// whose post-deploy probe requests this Worker's `GET /health` with the deployed Worker's vars and the Worker secrets
// the account holds. Worker secret values are write-only to the deploy, so the deployed Worker checks its own keys and
// the probe reads the answer.
import { describe, expect, it, vi } from "vitest";
import { account } from "./support.ts";

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
      const logged: unknown[] = [];
      const log = vi
        .spyOn(console, "error")
        .mockImplementation((...args) => void logged.push(...args));
      const failed = await clash.deploy().finally(() => log.mockRestore());
      expect(failed.ok, name).toBe(false);
      expect(failed.stages.at(-1), name).toMatchObject({ stage: "probes", ok: false });
      expect(failed.stages.at(-1)!.detail).toContain("control-plane: GET /health failed");
      expect(clash.probes, name).toEqual([{ status: 503, body: { status: "misconfigured" } }]);
      expect(clash.alarms[0]).toMatch(/^deploy-probe-failed: /);
      // `/health` is public: the body names neither binding of the clash nor the shared value.
      const body = JSON.stringify(clash.probes);
      for (const leak of ["PROVENANCE_KEY", name, DISTINCT.PROVENANCE_KEY])
        expect(body, name).not.toContain(leak);
      // The operator reads the refused binding and the reason in the Worker log.
      expect(logged.join("\n"), name).toContain(
        `PROVENANCE_KEY: the provenance key equals ${name}`,
      );
    }
  });
});
