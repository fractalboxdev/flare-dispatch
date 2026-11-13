// The deploy suites of `V-DEPLOY` (specs/verification.md § Harness catalog) for the provenance configuration
// (specs/provenance.md): the overlay's attestation timing rule at the decode stage, and no policy root key on any Worker
// the deploy carries, in the drift stage, on the fakes of `support.ts`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerSpec } from "../../src/cli/index.ts";
import { placeholderOverlay } from "../../src/index.ts";
import {
  CONTROL_PLANE,
  deploy,
  fd,
  isWrite,
  OVERLAY,
  RECORD,
  ROOT,
  SCRIPT,
  since,
  world,
} from "./support.ts";

const withProvenance = (provenance: Record<string, unknown>) =>
  JSON.stringify({ ...placeholderOverlay, provenance });

const ROOT_KEY_DETAIL =
  "the Worker holds a policy root key; the operator holds it outside the control plane";

// The committed control-plane template with a `POLICY_ROOT_KEY` var beside its vars.
let dir: string;
let WITH_ROOT_KEY_VAR: WorkerSpec;
beforeAll(() => {
  mkdirSync(join(ROOT, ".tmp"), { recursive: true });
  dir = mkdtempSync(join(ROOT, ".tmp", "deploy-provenance-"));
  const template = readFileSync(join(ROOT, CONTROL_PLANE.templatePath), "utf8");
  const added = template.replace(
    /\n(\s*)"POLICY_RULES": "\{\{policy\.rules\}\}",/,
    '\n$1"POLICY_RULES": "{{policy.rules}}",\n$1"POLICY_ROOT_KEY": "placeholder-root-key",',
  );
  expect(added).not.toBe(template);
  writeFileSync(join(dir, "wrangler.jsonc"), added);
  WITH_ROOT_KEY_VAR = {
    ...CONTROL_PLANE,
    templatePath: relative(ROOT, join(dir, "wrangler.jsonc")),
  };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("provenance configuration in the deploy", () => {
  it("[FD-PROV-077] fd deploy and fd doctor refuse an overlay whose attestation_max_age is below reattest_interval plus 48 h at the decode stage, before any Cloudflare call", async () => {
    for (const provenance of [
      { attestationMaxAgeDays: 8, reattestIntervalDays: 7 },
      { reattestIntervalDays: 14 },
    ]) {
      const w = world();
      const report = await deploy(w, withProvenance(provenance));
      expect(report.ok).toBe(false);
      expect(report.stages).toEqual([
        {
          stage: "decode",
          ok: false,
          detail: expect.stringContaining("provenance.attestationMaxAgeDays: attestation_max_age"),
        },
      ]);
      expect(w.calls).toEqual([]);
      expect(w.runs).toEqual([]);

      const checked = await Effect.runPromise(fd(world()).doctor(withProvenance(provenance)));
      expect(checked.ok).toBe(false);
      expect(checked.stages.at(-1)).toMatchObject({ stage: "decode", ok: false });
    }

    const w = world();
    const ok = await deploy(
      w,
      withProvenance({ attestationMaxAgeDays: 16, reattestIntervalDays: 14 }),
    );
    expect(ok.ok).toBe(true);
  });

  it("[FD-PROV-045] the deploy delivers no policy root key to the control plane: the committed template deploys clean, and a policy root key in the overlay, the rendered configuration or the deployed Worker's secrets fails before any write", async () => {
    const clean = world();
    const report = await deploy(clean);
    expect(report.ok).toBe(true);
    expect(report.stages.find((s) => s.stage === "drift")?.detail).not.toContain("policy root");

    // The overlay has no path for it.
    const overlay = world();
    const refused = await deploy(overlay, withProvenance({ policyRootKey: "root-private-jwk" }));
    expect(refused.stages).toEqual([
      { stage: "decode", ok: false, detail: expect.stringContaining("provenance.policyRootKey") },
    ]);
    expect(overlay.calls).toEqual([]);

    // A binding of the rendered configuration.
    const rendered = world();
    const bound = await deploy(rendered, OVERLAY, { workers: [WITH_ROOT_KEY_VAR] });
    expect(bound.ok).toBe(false);
    expect(bound.stages.at(-1)).toEqual({
      stage: "drift",
      ok: false,
      detail: `control-plane.POLICY_ROOT_KEY: ${ROOT_KEY_DETAIL}`,
    });
    expect(rendered.calls.filter(isWrite)).toEqual([]);
    expect(rendered.scripts.has(SCRIPT)).toBe(false);

    // A Worker secret put on the deployed control plane out of band, with no record to compare it with.
    clean.putSecret(SCRIPT, "POLICY_ROOT_KEY", "root-secret-value");
    clean.objects.delete(RECORD);
    const from = clean.calls.length;
    const again = await deploy(clean);
    expect(again.stages.at(-1)).toEqual({
      stage: "drift",
      ok: false,
      detail: `control-plane.POLICY_ROOT_KEY: ${ROOT_KEY_DETAIL}`,
    });
    expect(again.stages.at(-1)!.detail).not.toContain("root-secret-value");
    expect(since(clean, from).filter(isWrite)).toEqual([]);

    const doctor = await Effect.runPromise(fd(clean).doctor(OVERLAY));
    expect(doctor.ok).toBe(false);
    expect(doctor.stages.at(-1)!.detail).toContain(
      `control-plane.POLICY_ROOT_KEY: ${ROOT_KEY_DETAIL}`,
    );
  });
});
