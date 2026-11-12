// The deploy suites of `V-DEPLOY` for the registry validator over read-only scan declarations (specs/runs/gate.md
// § Terms): the run catalogue's declarations checked by the `deploy-dry-run` job's drift check (`staticDrift`) and by
// the drift stage of `fd deploy` and `fd doctor`, on the fakes of `support.ts`.
import { AGENTIC_CATALOG } from "@fractalboxdev/flare-dispatch-agentic";
import type { RunDeclaration, RunRegistry } from "@fractalboxdev/flare-dispatch-catalog";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { placeholderOverlay } from "../../src/index.ts";
import { staticDrift } from "../../src/cli/index.ts";
import {
  CONTROL_PLANE,
  deploy,
  fd,
  isWrite,
  READ_ONLY_SCAN,
  ROOT,
  withRescan,
  world,
} from "./support.ts";

const TEMPLATE = readFileSync(join(ROOT, CONTROL_PLANE.templatePath), "utf8");

/** Each way a readOnlyScan declaration breaks its definition, with the reason the validator names. */
const broken: readonly (readonly [RunDeclaration, string])[] = [
  [
    {
      ...READ_ONLY_SCAN,
      input: Schema.Struct({ repo: Schema.String, sha: Schema.String, command: Schema.String }),
    },
    "readOnlyScan: command input command",
  ],
  [
    {
      ...READ_ONLY_SCAN,
      agentic: { declaration: { callSites: [{ name: "triager" }], intentKinds: ["check.open"] } },
    },
    "readOnlyScan: model call site triager",
  ],
  [
    {
      ...READ_ONLY_SCAN,
      spec: { ...READ_ONLY_SCAN.spec, intentKinds: ["check.open", "pr.comment"] },
    },
    "readOnlyScan: intent kind pr.comment",
  ],
];

const scanFindings = (runs?: RunRegistry) =>
  Effect.runSync(
    staticDrift(CONTROL_PLANE, TEMPLATE, placeholderOverlay, AGENTIC_CATALOG, runs),
  ).findings.filter((f) => f.check === "read-only-scan");

const driftStage = (report: {
  readonly stages: readonly { stage: string; ok: boolean; detail: string }[];
}) => report.stages.find((s) => s.stage === "drift");

describe("the registry validator over read-only scan declarations at deploy", () => {
  it("[FD-GATE-113] the deploy-dry-run drift check passes the committed catalogue and a clean read-only scan run, and fails one holding a command input, a model call site or a non-check.* intent kind", () => {
    expect(scanFindings()).toEqual([]);
    expect(scanFindings(withRescan())).toEqual([]);
    for (const [declaration, reason] of broken)
      expect(scanFindings(withRescan(declaration))).toEqual([
        {
          check: "read-only-scan",
          path: "runs.security-rescan.readOnlyScan",
          detail: reason,
          severity: "failure",
        },
      ]);
  });

  it("[FD-GATE-113] fd deploy fails at the drift stage, before any write, on a read-only scan declaration that breaks its definition, and fd doctor fails on it", async () => {
    const ok = await deploy(world(), undefined, { runRegistry: withRescan() });
    expect(ok.ok).toBe(true);
    expect(driftStage(ok)?.detail ?? "").not.toContain("readOnlyScan");

    for (const [declaration, reason] of broken) {
      const w = world();
      const report = await deploy(w, undefined, { runRegistry: withRescan(declaration) });
      expect(report.ok).toBe(false);
      expect(report.stages.at(-1)).toMatchObject({ stage: "drift", ok: false });
      expect(report.stages.at(-1)?.detail).toContain(
        `runs.security-rescan.readOnlyScan: ${reason}`,
      );
      expect(w.calls.filter(isWrite)).toEqual([]);
    }

    const checked = await Effect.runPromise(
      fd(world(), { runRegistry: withRescan(broken[0]![0]) }).doctor(
        JSON.stringify(placeholderOverlay),
      ),
    );
    expect(checked.ok).toBe(false);
    expect(driftStage(checked)?.detail).toContain("runs.security-rescan.readOnlyScan");
  });
});
