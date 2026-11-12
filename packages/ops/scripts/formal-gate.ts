// The `formal` job (specs/verification.md FD-VER-014 to FD-VER-016, FD-VER-022, FD-PROV-073):
//
//   node --experimental-strip-types packages/ops/scripts/formal-gate.ts [--base <ref>]
//
// It checks the toolchain pin, scans for forbidden terms, runs `lake build` in formal/, prints every theorem's axioms
// and fails on one outside the allowed three; with `--base` it also requires `formal/regressions.jsonl` to grow only.
// It then checks `tamarin-prover` and `maude` against `formal/tamarin-prover.version`, runs
// `tamarin-prover --prove` on `formal/provenance.spthy` and fails unless every lemma is `verified`.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  axiomFindings,
  axiomsProgram,
  forbiddenTerms,
  parseTamarinPin,
  regressionsAppendOnly,
  spthyLemmas,
  tamarinFindings,
  tamarinVersionFindings,
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

// FD-PROV-073. The derivation check runs with a 300 s timeout, well above its runtime on this model; a check that
// times out prints "wellformedness check failed", so a timeout fails the gate as a wellformedness failure.
const pin = parseTamarinPin(readFileSync(join(formal, "tamarin-prover.version"), "utf8"));
if (pin === null)
  findings.push({
    check: "FD-PROV-073",
    file: "formal/tamarin-prover.version",
    line: 1,
    message: "the pin names not exactly one release of each of tamarin-prover and maude",
  });
else {
  const prover = (argv: readonly string[]) => {
    const run = spawnSync("tamarin-prover", argv, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
    return `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  };
  findings.push(...tamarinVersionFindings(pin, prover(["--version"])));
  const output = prover(["--prove", "--derivcheck-timeout=300", "formal/provenance.spthy"]);
  const at = output.lastIndexOf("summary of summaries:");
  console.log(at === -1 ? output.slice(-4000).trim() : output.slice(at).trim());
  findings.push(
    ...tamarinFindings(spthyLemmas(readFileSync(join(formal, "provenance.spthy"), "utf8")), output),
  );
}

for (const f of findings) console.log(`${f.check} ${f.file}:${f.line} ${f.message}`);
console.log(`formal: ${names.length} theorem(s), ${findings.length} finding(s)`);
process.exit(findings.length === 0 ? 0 : 1);
