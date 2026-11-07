// The `phase-gate` job (specs/verification.md FD-VER-026 to FD-VER-031):
//
//   node --experimental-strip-types packages/ops/scripts/phase-gate.ts --base <ref> [--records <file.json>]
//
// It passes only when `.github/phase` moves from n to n + 1 and every condition holds. `--records` names a JSON file of
// `{ nightly, measures, alarms, killLines, windowEnd }` read from the nightly runs and the deployed control plane; a
// condition with no record fails.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { phaseGate, type PhaseGateInput } from "../src/verification/phase-gate.ts";
import { allRequirements, harnessEntries } from "../src/verification/spec-tags.ts";
import { args, readAt, readSpecs, readTree, ROOT } from "./repo.ts";

const opts = args(process.argv.slice(2));
const base = opts.get("base");
if (base === undefined) {
  console.error("--base <ref> names the pull request's base commit");
  process.exit(2);
}
const from = Number((readAt(base, ".github/phase") ?? "").trim());
const to = Number(readFileSync(join(ROOT, ".github/phase"), "utf8").trim());
if (from === to) {
  console.log(`phase-gate: .github/phase stays at ${to}; nothing to gate`);
  process.exit(0);
}
const recordsPath = opts.get("records");
const records = (
  recordsPath !== undefined && existsSync(recordsPath)
    ? JSON.parse(readFileSync(recordsPath, "utf8"))
    : {}
) as Partial<Pick<PhaseGateInput, "nightly" | "measures" | "alarms" | "killLines" | "windowEnd">>;
const files = readTree(ROOT, (p) => p.endsWith(".test.ts") || p.startsWith("formal/"));
const findings = phaseGate({
  from,
  to,
  requirements: allRequirements(readSpecs()),
  passing: [...files].flatMap(([path, text]) => harnessEntries(path, text)),
  nightly: records.nightly ?? {},
  measures: records.measures ?? null,
  alarms: records.alarms ?? null,
  killLines: records.killLines ?? null,
  windowEnd: records.windowEnd ?? Date.now(),
});
for (const f of findings) console.log(`${f.check} ${f.message}`);
console.log(`phase-gate ${from} → ${to}: ${findings.length} finding(s)`);
process.exit(findings.length === 0 ? 0 : 1);
