import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  axiomFindings,
  axiomsProgram,
  forbiddenTerms,
  proofCounts,
  regressionsAppendOnly,
  theoremNames,
  toolchainPinned,
} from "./formal.ts";
import { killLineAlarms, phaseGate, type PhaseGateInput } from "./phase-gate.ts";
import type { Requirement } from "./spec-tags.ts";

const ROOT = join(import.meta.dirname, "../../../..");

describe("formal gate", () => {
  it("[FD-VER-014] formal/lean-toolchain pins one exact Lean release", () => {
    expect(toolchainPinned(readFileSync(join(ROOT, "formal/lean-toolchain"), "utf8"))).toBe(true);
    expect(toolchainPinned("leanprover/lean4:stable")).toBe(false);
    expect(toolchainPinned("leanprover/lean4:v4.35.0-rc1")).toBe(false);
  });

  it("[FD-VER-015] sorry, admit, native_decide or an axiom declaration fails naming file and line; comments do not", () => {
    const text = [
      "-- sorry in a comment is fine",
      "/- admit here too -/",
      "theorem a : True := by sorry",
      "axiom choice' : False",
      "theorem b : 2 = 2 := by native_decide",
    ].join("\n");
    expect(forbiddenTerms("formal/X.lean", text).map((f) => [f.line, f.message])).toEqual([
      [3, "sorry in a formal/ file"],
      [4, "axiom in a formal/ file"],
      [5, "native_decide in a formal/ file"],
    ]);
    expect(
      forbiddenTerms(
        "formal/FdFormal/Basic.lean",
        readFileSync(join(ROOT, "formal/FdFormal/Basic.lean"), "utf8"),
      ),
    ).toEqual([]);
  });

  it("[FD-VER-016] a theorem whose axioms go beyond propext, Classical.choice and Quot.sound fails", () => {
    expect(theoremNames("namespace A\ntheorem t : True := trivial\nend A")).toEqual(["A.t"]);
    expect(axiomsProgram("FdFormal", ["A.t"])).toBe("import FdFormal\n#print axioms A.t");
    const output = [
      "'A.t' depends on axioms: [propext, Classical.choice, Quot.sound]",
      "'A.u' depends on axioms: [propext, sorryAx]",
      "'A.v' does not depend on any axioms",
    ].join("\n");
    expect(axiomFindings(output).map((f) => f.message)).toEqual(["A.u depends on axiom sorryAx"]);
  });

  it("[FD-VER-018] a proof counts only while its theorem passes and every assumption test of its row passes", () => {
    const passing = new Set(["FD-AGT-009", "FD-AGT-012"]);
    expect(
      proofCounts({
        theoremPassed: true,
        assumptionTests: ["FD-AGT-009", "FD-AGT-012"],
        passingTests: passing,
      }),
    ).toBe(true);
    expect(
      proofCounts({
        theoremPassed: true,
        assumptionTests: ["FD-AGT-009", "FD-AGT-013"],
        passingTests: passing,
      }),
    ).toBe(false);
    expect(proofCounts({ theoremPassed: false, assumptionTests: [], passingTests: passing })).toBe(
      false,
    );
  });

  it("[FD-VER-022] a pull request that removes or changes a regression line fails; appending passes", () => {
    const base = '{"seed":1}\n{"seed":2}\n';
    expect(regressionsAppendOnly(base, `${base}{"seed":3}\n`)).toEqual([]);
    expect(regressionsAppendOnly(base, '{"seed":1}\n')).toHaveLength(1);
    expect(regressionsAppendOnly(base, '{"seed":1}\n{"seed":9}\n')).toHaveLength(1);
  });
});

const req = (id: string, phase: number, tags: string[]): Requirement => ({
  id,
  area: id.split("-")[1]!,
  number: Number(id.split("-")[2]),
  phase,
  tags,
  sentence: "The x must y.",
  file: "operability.md",
  line: 1,
});

const gate = (over: Partial<PhaseGateInput> = {}): PhaseGateInput => ({
  from: 0,
  to: 1,
  requirements: [
    req("FD-OPS-053", 0, ["V-UNIT"]),
    req("FD-OPS-038", 0, ["V-LIVE"]),
    req("FD-OPS-071", 1, ["V-UNIT"]),
  ],
  passing: [{ id: "FD-OPS-053", tag: "V-UNIT", file: "x.test.ts" }],
  nightly: { conf: true, sim: true, "e2e-local": true, diff: true },
  measures: [{ name: "warm-run", holds: true, detail: "" }],
  alarms: [],
  killLines: [],
  windowEnd: 10 * 86_400_000,
  ...over,
});
const checks = (i: PhaseGateInput) => phaseGate(i).map((f) => f.check);

describe("phase gate", () => {
  it("[FD-VER-026] every requirement of phase n or lower needs a passing entry per tag, V-LIVE and V-MEASURE aside", () => {
    expect(phaseGate(gate())).toEqual([]);
    expect(phaseGate(gate({ passing: [] })).map((f) => f.message)).toEqual([
      "FD-OPS-053 has no passing V-UNIT entry",
    ]);
    expect(checks(gate({ to: 2 }))).toEqual(["FD-VER-026"]);
  });

  it("[FD-VER-027] the nightly conf, sim, e2e-local and diff runs must have passed", () => {
    expect(
      phaseGate(gate({ nightly: { conf: true, sim: false, diff: true } })).map((f) => f.message),
    ).toEqual(["nightly sim failed", "nightly e2e-local has no record"]);
  });

  it("[FD-VER-028] every V-MEASURE threshold of gate n must hold, read from the control plane's record", () => {
    expect(
      checks(gate({ measures: [{ name: "warm-run", holds: false, detail: "22% faster" }] })),
    ).toEqual(["FD-VER-028"]);
    expect(checks(gate({ measures: null }))).toEqual(["FD-VER-028"]);
  });

  it("[FD-VER-029] a V-LIVE page alarm unresolved for more than 24 h in the window fails", () => {
    const day = 86_400_000;
    expect(
      checks(
        gate({
          alarms: [{ name: "canary-missed", requirementPhase: 0, raisedAt: 0, resolvedAt: day }],
        }),
      ),
    ).toEqual([]);
    expect(
      checks(
        gate({
          alarms: [
            { name: "canary-missed", requirementPhase: 0, raisedAt: 0, resolvedAt: day + 1 },
          ],
        }),
      ),
    ).toEqual(["FD-VER-029"]);
    expect(
      checks(gate({ alarms: [{ name: "x", requirementPhase: 0, raisedAt: 0, resolvedAt: null }] })),
    ).toEqual(["FD-VER-029"]);
  });

  it("[FD-VER-030] a crossed kill line raises kill-line naming the risk, the metric, its value and the threshold", () => {
    expect(
      killLineAlarms([
        {
          risk: "warm state",
          metric: "median time to verdict",
          value: 0.2,
          threshold: 0.3,
          crossed: true,
        },
        { risk: "toil", metric: "interventions", value: 0, threshold: 1, crossed: false },
      ]),
    ).toEqual([
      {
        name: "kill-line",
        severity: "notify",
        dedupeKey: "kill-line:warm state",
        detail: {
          risk: "warm state",
          metric: "median time to verdict",
          value: 0.2,
          threshold: 0.3,
        },
      },
    ]);
  });

  it("[FD-VER-031] an unresolved kill-line notification fails the gate for every phase above the current one", () => {
    expect(checks(gate({ killLines: ["warm state"] }))).toEqual(["FD-VER-031"]);
    expect(checks(gate({ killLines: null }))).toEqual(["FD-VER-031"]);
  });
});
