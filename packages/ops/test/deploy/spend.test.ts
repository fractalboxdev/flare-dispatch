// The deploy suites of `V-DEPLOY` (specs/verification.md § Harness catalog) for the spend configuration of
// specs/profile.md § Spend configuration: `fd deploy` over the committed control-plane template renders the overlay's
// spend values into the Worker's `SPEND` var, which the coordinator reads, on the fakes of `support.ts`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spendDefaults } from "@fractalboxdev/flare-dispatch-profile";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { placeholderOverlay, spendConfigOf, spendConfigOfVar } from "../../src/index.ts";
import type { WorkerSpec } from "../../src/cli/index.ts";
import { CONTROL_PLANE, deploy, isWrite, ROOT, SCRIPT, world, type World } from "./support.ts";

/** The `SPEND` var of the control plane as the account holds it after a deploy. */
const deployedSpend = (w: World): unknown =>
  (
    w.scripts.get(SCRIPT)?.bindings.find((b) => b["name"] === "SPEND") as
      | { type: string; json: unknown }
      | undefined
  )?.json;

const withSpend = (spend: Record<string, number>) =>
  JSON.stringify({ ...placeholderOverlay, spend });

// The committed control-plane template with its `SPEND` var removed.
let dir: string;
let WITHOUT_SPEND: WorkerSpec;
beforeAll(() => {
  mkdirSync(join(ROOT, ".tmp"), { recursive: true });
  dir = mkdtempSync(join(ROOT, ".tmp", "deploy-spend-"));
  const template = readFileSync(join(ROOT, CONTROL_PLANE.templatePath), "utf8");
  const stripped = template.replace(/\n\s*"SPEND": "\{\{spend\}\}",/, "");
  expect(stripped).not.toBe(template);
  writeFileSync(join(dir, "wrangler.jsonc"), stripped);
  WITHOUT_SPEND = { ...CONTROL_PLANE, templatePath: relative(ROOT, join(dir, "wrangler.jsonc")) };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("fd deploy delivers the overlay's spend configuration to the control plane", () => {
  it("[FD-PROF-054] the deployed SPEND var carries each spend value the overlay sets and the default of each it leaves out", async () => {
    const w = world();
    const overlay = { budgetUsd: 120, releaseReserveUsd: 15, measuredReserveDays: 14 };
    const report = await deploy(w, withSpend(overlay));
    expect(report.ok).toBe(true);
    expect(deployedSpend(w)).toEqual({
      budgetUsd: 120,
      fixedUsd: 0,
      releaseReserveUsd: 15,
      opsReserveUsd: 5,
      measuredReserveMinUsd: 20,
      measuredReserveDays: 14,
      overheadFactor: 1.1,
    });
    // The coordinator's reader of that var answers the overlay's spend configuration.
    expect(Effect.runSync(spendConfigOfVar(deployedSpend(w)))).toEqual(
      spendConfigOf({ ...placeholderOverlay, spend: overlay }),
    );
  });

  it("[FD-PROF-054] an overlay that sets no spend value deploys every default, and a changed overlay redeploys the new values", async () => {
    const w = world();
    expect((await deploy(w)).ok).toBe(true);
    expect(Effect.runSync(spendConfigOfVar(deployedSpend(w)))).toEqual(spendDefaults);

    expect((await deploy(w, withSpend({ budgetUsd: 80, overheadFactor: 1.3 }))).ok).toBe(true);
    expect(Effect.runSync(spendConfigOfVar(deployedSpend(w)))).toEqual({
      ...spendDefaults,
      budget: 80_000_000,
      overhead_factor: 1.3,
    });
  });

  it("[FD-PROF-054] fails an overlay whose spend configuration puts a profile line above the next higher rank's in the drift stage, before any write", async () => {
    // budgetUsd 20 leaves G = 20 - 0 - 10 - 20 = -10 USD: interactive -10 USD sits below batch's 0.45 x G = -4.5 USD.
    const w = world();
    const report = await deploy(w, withSpend({ budgetUsd: 20 }));
    expect(report.ok).toBe(false);
    expect(report.stages.at(-1)).toMatchObject({ stage: "drift", ok: false });
    expect(w.calls.filter(isWrite)).toEqual([]);
    expect(report.stages.at(-1)?.detail).toContain(
      "classes.batch.line: line above the next higher rank's",
    );
    expect(deployedSpend(w)).toBeUndefined();
  });

  it("[FD-PROF-054] fails a control-plane template that carries no SPEND var in the drift stage, before any write", async () => {
    const w = world();
    const report = await deploy(w, withSpend({ budgetUsd: 120 }), { workers: [WITHOUT_SPEND] });
    expect(report.ok).toBe(false);
    expect(report.stages.at(-1)).toMatchObject({ stage: "drift", ok: false });
    expect(report.stages.at(-1)?.detail).toContain("SPEND");
    expect(w.calls.filter(isWrite)).toEqual([]);
  });
});
