// The `spec-tags` check (specs/verification.md FD-VER-001 to FD-VER-013, FD-VER-034 to FD-VER-037).
//
//   node --experimental-strip-types packages/ops/scripts/spec-tags.ts [--base <ref>] [--report]
//
// `--base` names the pull request's base commit for the removal and reuse checks; `--report` also prints, per tag,
// the requirements of the current phase or lower with no harness entry. Exits non-zero on any finding.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  allRequirements,
  coverageReport,
  harnessEntries,
  pinnedCommit,
  specTags,
} from "../src/verification/spec-tags.ts";
import {
  args,
  readMamekoSpecs,
  readSpecs,
  readSpecsAt,
  readTree,
  ROOT,
  vendoredMamekoCommit,
} from "./repo.ts";

const opts = args(process.argv.slice(2));
const specs = readSpecs();
const pin = pinnedCommit(specs.get("README.md") ?? "");
const vendored = vendoredMamekoCommit();
if (pin !== null && pin !== vendored) {
  console.error(
    `vendor/mameko is at ${vendored}; specs/README.md pins ${pin}. Check out the pin to run FD-VER-035.`,
  );
  process.exit(1);
}
const base = opts.get("base");
const findings = specTags({
  specs,
  moved: readFileSync(join(ROOT, "specs/ids.moved.tsv"), "utf8"),
  baseSpecs: base === undefined ? null : readSpecsAt(base),
  mamekoSpecs: readMamekoSpecs().values(),
  formal: readTree(join(ROOT, "formal"), (p) => p.endsWith(".lean") || p.endsWith(".spthy")),
});
for (const f of findings) console.log(`${f.check} specs/${f.file}:${f.line} ${f.message}`);

if (opts.has("report")) {
  const phase = Number(readFileSync(join(ROOT, ".github/phase"), "utf8").trim());
  const files = readTree(ROOT, (p) => p.endsWith(".test.ts") || p.startsWith("formal/"));
  const entries = [...files].flatMap(([path, text]) => harnessEntries(path, text));
  const report = coverageReport(allRequirements(specs), entries, phase);
  for (const [tag, missing] of report)
    console.log(
      `${tag}: ${missing.length} requirement(s) of phase ${phase} or lower with no entry${missing.length === 0 ? "" : `: ${missing.join(" ")}`}`,
    );
}

console.log(`spec-tags: ${findings.length} finding(s)`);
process.exit(findings.length === 0 ? 0 : 1);
