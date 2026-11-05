// The `phase-gate` job of a pull request that moves `.github/phase` from n to n + 1 (specs/verification.md
// FD-VER-026 to FD-VER-031). Every condition reads a record; a missing record fails its condition.
import type { HarnessEntry, Requirement, SpecFinding } from "./spec-tags.ts";

/** The tags whose harness entries the phase gate requires; `V-LIVE` and `V-MEASURE` are read as records instead. */
const ENTRY_TAGS = [
  "V-UNIT",
  "V-CONF",
  "V-SIM",
  "V-REPLAY",
  "V-E2E-LOCAL",
  "V-DEPLOY",
  "V-PROOF",
  "V-DIFF",
];

/** The nightly harnesses FD-VER-027 reads. */
export const NIGHTLY = ["conf", "sim", "e2e-local", "diff"] as const;

/** One `V-MEASURE` threshold of gate n, read over its window. */
export interface MeasureRecord {
  readonly name: string;
  readonly holds: boolean;
  readonly detail: string;
}

/** One page alarm of the gate window, with the phase of the `V-LIVE` requirement it serves. */
export interface PageAlarmRecord {
  readonly name: string;
  readonly requirementPhase: number;
  readonly raisedAt: number;
  readonly resolvedAt: number | null;
}

/** What the phase gate reads beside the spec lines and the harness entries. */
export interface PhaseGateInput {
  readonly from: number;
  readonly to: number;
  readonly requirements: readonly Requirement[];
  /** Harness entries that passed on the base commit. */
  readonly passing: readonly HarnessEntry[];
  /** The last result of each nightly harness on the base commit or later; absent means no record. */
  readonly nightly: Readonly<Partial<Record<(typeof NIGHTLY)[number], boolean>>>;
  /** The `V-MEASURE` thresholds of gate n; null when the control plane's record could not be read. */
  readonly measures: readonly MeasureRecord[] | null;
  /** The page alarms of the gate window; null when the record could not be read. */
  readonly alarms: readonly PageAlarmRecord[] | null;
  /** Unresolved `kill-line` notifications. */
  readonly killLines: readonly string[] | null;
  readonly windowEnd: number;
}

const DAY_MS = 86_400_000;
const finding = (check: string, message: string): SpecFinding => ({
  check,
  file: ".github/phase",
  line: 1,
  message,
});

/** Every reason the gate fails; empty means the phase may move. */
export const phaseGate = (input: PhaseGateInput): readonly SpecFinding[] => {
  const out: SpecFinding[] = [];
  if (input.to !== input.from + 1)
    return [finding("FD-VER-026", `the phase moves from ${input.from} to ${input.to}, not by one`)];
  // FD-VER-026: a passing entry per tag for every requirement of phase n or lower.
  const have = new Set(input.passing.map((e) => `${e.tag} ${e.id}`));
  for (const r of input.requirements)
    if (r.phase <= input.from)
      for (const t of r.tags)
        if (ENTRY_TAGS.includes(t) && !have.has(`${t} ${r.id}`))
          out.push(finding("FD-VER-026", `${r.id} has no passing ${t} entry`));
  // FD-VER-027: the nightly runs.
  for (const n of NIGHTLY)
    if (input.nightly[n] !== true)
      out.push(
        finding(
          "FD-VER-027",
          `nightly ${n} ${input.nightly[n] === false ? "failed" : "has no record"}`,
        ),
      );
  // FD-VER-028: the V-MEASURE thresholds of gate n.
  if (input.measures === null)
    out.push(finding("FD-VER-028", "the V-MEASURE record could not be read"));
  else
    for (const m of input.measures)
      if (!m.holds) out.push(finding("FD-VER-028", `${m.name}: ${m.detail}`));
  // FD-VER-029: no page alarm of a V-LIVE requirement of phase n or lower unresolved for more than 24 h.
  if (input.alarms === null) out.push(finding("FD-VER-029", "the alarm record could not be read"));
  else
    for (const a of input.alarms)
      if (
        a.requirementPhase <= input.from &&
        (a.resolvedAt ?? input.windowEnd) - a.raisedAt > DAY_MS
      )
        out.push(finding("FD-VER-029", `${a.name} stayed unresolved for more than 24 h`));
  // FD-VER-031: an unresolved kill line stops every phase above the current one.
  if (input.killLines === null)
    out.push(finding("FD-VER-031", "the kill-line record could not be read"));
  else
    for (const k of input.killLines) out.push(finding("FD-VER-031", `kill line unresolved: ${k}`));
  return out;
};

/** One kill line of specs/roadmap.md § Kill lines, read over its window. */
export interface KillLineReading {
  readonly risk: string;
  readonly metric: string;
  readonly value: number;
  readonly threshold: number;
  readonly crossed: boolean;
}

/** The `kill-line` notification for each crossed line, naming the risk, metric, value and threshold (FD-VER-030). */
export const killLineAlarms = (readings: readonly KillLineReading[]) =>
  readings
    .filter((r) => r.crossed)
    .map((r) => ({
      name: "kill-line",
      severity: "notify" as const,
      dedupeKey: `kill-line:${r.risk}`,
      detail: { risk: r.risk, metric: r.metric, value: r.value, threshold: r.threshold },
    }));
