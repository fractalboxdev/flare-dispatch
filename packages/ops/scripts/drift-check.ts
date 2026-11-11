// The pull-request part of the drift check (specs/operability.md FD-OPS-019 to FD-OPS-021, FD-OPS-026, FD-ARCH-001,
// FD-INT-050, specs/profile.md FD-PROF-033, FD-PROF-064): the dispatcher's template rendered from the placeholder
// overlay, against the template's invariants, the environment schema, the pool caps, the components of
// specs/architecture.md and mameko's profile validator over the production profile. The profile step's findings follow
// the configuration checks' (`driftCheckFindings`); `fd deploy` and `fd doctor` compose their drift stage the same way
// (`withProfileStep`).
//
//   node --experimental-strip-types packages/ops/scripts/drift-check.ts [--out <dir>]
//
// `--out` writes each rendered configuration there, for `wrangler deploy --dry-run -c <file>`.
import { profileDocumentFor, validationContext } from "@fractalboxdev/flare-dispatch-profile";
import { Effect } from "effect";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { staticDrift, V2_WORKERS } from "../src/cli/operability.ts";
import { driftCheckFindings, type Finding } from "../src/drift.ts";
import { placeholderOverlay } from "../src/overlay.ts";
import { args, ROOT } from "./repo.ts";

const opts = args(process.argv.slice(2));
const out = opts.get("out");
const configFindings: Finding[] = [];
for (const spec of V2_WORKERS.filter((w) => w.dispatcher === true)) {
  const template = readFileSync(join(ROOT, spec.templatePath), "utf8");
  const checked = Effect.runSync(staticDrift(spec, template, placeholderOverlay));
  configFindings.push(...checked.findings);
  if (out !== undefined) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${spec.worker}.jsonc`), checked.rendered);
  }
}
const findings = Effect.runSync(
  driftCheckFindings(configFindings, profileDocumentFor("production"), validationContext),
);
for (const f of findings) console.log(`${f.severity} ${f.check} ${f.path}: ${f.detail}`);
const failures = findings.filter((f) => f.severity === "failure").length;
console.log(`drift-check: ${failures} failure(s), ${findings.length - failures} warning(s)`);
process.exit(failures === 0 ? 0 : 1);
