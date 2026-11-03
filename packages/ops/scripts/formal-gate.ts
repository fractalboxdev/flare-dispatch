// The `formal` job (specs/verification.md FD-VER-014 to FD-VER-016, FD-VER-022):
//
//   node --experimental-strip-types packages/ops/scripts/formal-gate.ts [--base <ref>]
//
// It checks the toolchain pin, scans for forbidden terms, runs `lake build` in formal/, prints every theorem's axioms
// and fails on one outside the allowed three; with `--base` it also requires `formal/regressions.jsonl` to grow only.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  axiomFindings,
  axiomsProgram,
  forbiddenTerms,
  regressionsAppendOnly,
  theoremNames,
  toolchainPinned,
} from "../src/verification/formal.ts";
import type { SpecFinding } from "../src/verification/spec-tags.ts";
import { args, readAt, readTree, ROOT } from "./repo.ts";

const opts = args(process.argv.slice(2));
const formal = join(ROOT, "formal");
const findings: SpecFinding[] = [];

if (!toolchainPinned(readFileSync(join(formal, "lean-toolchain"), "utf8")))
  findings.push({
    check: "FD-VER-014",
    file: "formal/lean-toolchain",
    line: 1,
    message: "the toolchain is not one exact release",
  });

const sources = readTree(formal, (p) => p.endsWith(".lean") && !p.startsWith(".lake"));
for (const [file, text] of sources) findings.push(...forbiddenTerms(`formal/${file}`, text));

try {
  execFileSync("lake", ["build"], { cwd: formal, stdio: "inherit" });
} catch {
  findings.push({ check: "FD-VER-014", file: "formal", line: 0, message: "lake build failed" });
}

const names = [...sources.values()].flatMap(theoremNames);
if (names.length > 0 && findings.length === 0) {
  mkdirSync(join(ROOT, ".tmp"), { recursive: true });
  const dir = mkdtempSync(join(ROOT, ".tmp", "axioms-"));
  const program = join(dir, "Axioms.lean");
  writeFileSync(program, axiomsProgram("FdFormal", names));
  const output = execFileSync("lake", ["env", "lean", program], { cwd: formal, encoding: "utf8" });
  findings.push(...axiomFindings(output));
  console.log(output.trim());
}

const base = opts.get("base");
if (base !== undefined)
  findings.push(
    ...regressionsAppendOnly(
      readAt(base, "formal/regressions.jsonl") ?? "",
      readFileSync(join(formal, "regressions.jsonl"), "utf8"),
    ),
  );

for (const f of findings) console.log(`${f.check} ${f.file}:${f.line} ${f.message}`);
console.log(`formal: ${names.length} theorem(s), ${findings.length} finding(s)`);
process.exit(findings.length === 0 ? 0 : 1);
