// The deploy suite of `V-DEPLOY` (specs/verification.md § Harness catalog) for the verdict record signing key
// (specs/github-output.md § Job and verdict records): `fd deploy` over the committed control-plane template and an
// overlay that sets `records.url`, whose post-deploy probe requests this Worker's `GET /health` with the deployed
// Worker's vars and the Worker secrets the account holds. Worker secret values are write-only to the deploy, so the
// deployed Worker checks its own keys and the probe reads the answer.
import { placeholderOverlay } from "@fractalboxdev/flare-dispatch-ops";
import { describe, expect, it, vi } from "vitest";
import { account } from "./support.ts";

const RECORDS = "records-signing-key-value";

const DISTINCT = {
  RECORDS_SIGNING_KEY: RECORDS,
  WEBHOOK_SECRET: "webhook-secret-value",
  LINK_KEY: "link-key-value",
  OIDC_SIGNING_JWK: "oidc-key-value",
  PROVENANCE_KEY: "provenance-key-value",
};

const overlay = { ...placeholderOverlay, records: { url: "https://records.example.com/hook" } };

describe("fd deploy against the control plane's records key check", () => {
  it("[FD-GH-099] fd deploy fails its post-deploy probe and pages when the records signing key equals the webhook secret, the link key, the OIDC key or the provenance key, and passes with every key distinct", async () => {
    const ok = account(DISTINCT, overlay);
    const report = await ok.deploy();
    expect(report.ok).toBe(true);
    expect(ok.probes).toEqual([
      {
        status: 200,
        body: { status: "ok", deployment: "production", plane_id: "flare-dispatch" },
      },
    ]);
    // The deployed Worker carries the overlay's records URL as a var; the key stays a Worker secret.
    expect(ok.vars()["RECORDS_URL"]).toBe("https://records.example.com/hook");
    expect(JSON.stringify(ok.vars())).not.toContain(RECORDS);

    for (const name of [
      "WEBHOOK_SECRET",
      "LINK_KEY",
      "OIDC_SIGNING_JWK",
      "PROVENANCE_KEY",
    ] as const) {
      const clash = account({ ...DISTINCT, [name]: RECORDS }, overlay);
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
      for (const leak of ["RECORDS_SIGNING_KEY", name, RECORDS])
        expect(body, name).not.toContain(leak);
      // The operator reads the refused binding and the reason in the Worker log.
      expect(logged.join("\n"), name).toContain(
        `RECORDS_SIGNING_KEY: the records signing key equals ${name}`,
      );
    }
  });
});
