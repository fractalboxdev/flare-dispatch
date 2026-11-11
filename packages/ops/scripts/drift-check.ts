// The pull-request part of the drift check (specs/operability.md FD-OPS-001, FD-OPS-012, FD-OPS-019 to FD-OPS-021,
// FD-OPS-026, FD-ARCH-001, FD-INT-050, specs/profile.md FD-PROF-033, FD-PROF-064, specs/model-gateway.md FD-MDL-020,
// FD-MDL-022, specs/runs/agentic.md FD-AGT-002, FD-AGT-004): the placeholder overlay's provider registry, and every
// Worker's template rendered from that overlay, against the template's invariants, the environment schema, the
// dispatcher's pool caps, the components of specs/architecture.md, the registry validator over the agentic recipes'
// declarations and mameko's profile validator over the production profile. The profile step's findings follow the
// configuration checks' (`driftCheckFindings`); `fd deploy` and `fd doctor` compose their drift stage the same way
// (`withProfileStep`).
//
//   node --experimental-strip-types packages/ops/scripts/drift-check.ts [--write]
//
// `--write` writes each rendered configuration beside its template as `<worker>.jsonc`
// (`apps/control-plane/control-plane.jsonc`, `apps/docs/docs.jsonc`), so the paths inside it resolve, for
// `wrangler deploy --dry-run -c <file>`.
import { profileDocumentFor, validationContext } from "@fractalboxdev/flare-dispatch-profile";
import { Effect } from "effect";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { staticDrift, V2_WORKERS } from "../src/cli/operability.ts";
import { driftCheckFindings, modelRegistryCheck, type Finding } from "../src/drift.ts";
import { modelRegistryOf, placeholderOverlay } from "../src/overlay.ts";
import { args, ROOT } from "./repo.ts";

const write = args(process.argv.slice(2)).has("write");
const configFindings: Finding[] = [...modelRegistryCheck(modelRegistryOf(placeholderOverlay))];
for (const spec of V2_WORKERS) {
  const template = readFileSync(join(ROOT, spec.templatePath), "utf8");
  const checked = Effect.runSync(staticDrift(spec, template, placeholderOverlay));
  configFindings.push(...checked.findings);
  if (write)
    writeFileSync(join(ROOT, dirname(spec.templatePath), `${spec.worker}.jsonc`), checked.rendered);
}
const findings = Effect.runSync(
  driftCheckFindings(configFindings, profileDocumentFor("production"), validationContext),
);
for (const f of findings) console.log(`${f.severity} ${f.check} ${f.path}: ${f.detail}`);
const failures = findings.filter((f) => f.severity === "failure").length;
console.log(`drift-check: ${failures} failure(s), ${findings.length - failures} warning(s)`);
process.exit(failures === 0 ? 0 : 1);
