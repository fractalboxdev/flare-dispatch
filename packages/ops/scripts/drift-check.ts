// The pull-request part of the drift check (specs/operability.md FD-OPS-019 to FD-OPS-021, FD-OPS-026, FD-ARCH-001,
// FD-INT-050): each v2 Worker template rendered from the placeholder overlay, against the template's invariants, the
// environment schema, the pool caps, the components of specs/architecture.md and mameko's profile validator.
//
//   node --experimental-strip-types packages/ops/scripts/drift-check.ts [--out <dir>]
//
// `--out` writes each rendered configuration there, for `wrangler deploy --dry-run -c <file>`.
import {
  CURRENT_PHASE,
  profileDocumentFor,
  validationContext,
} from "@fractalboxdev/flare-dispatch-profile";
import { Effect } from "effect";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { architectureFindings } from "../src/architecture.ts";
import {
  admissionCapCheck,
  bindingCheck,
  profileCheck,
  templateInvariants,
  unrenderedCheck,
  type Finding,
} from "../src/drift.ts";
import { placeholderOverlay } from "../src/overlay.ts";
import { parseJsonc, renderTemplate } from "../src/render.ts";
import { args, ROOT } from "./repo.ts";

/** Each v2 Worker: its template and the bindings its environment schema declares. */
const WORKERS = [
  {
    worker: "control-plane",
    template: "apps/control-plane/wrangler.jsonc",
    bindings: ["DB", "CHANNEL", "EXECUTION", "EPOCH_ANCHOR", "MONITOR", "PLANE_ID", "DEPLOYMENT"],
  },
];

const opts = args(process.argv.slice(2));
const out = opts.get("out");
const findings: Finding[] = [];
for (const w of WORKERS) {
  const template = readFileSync(join(ROOT, w.template), "utf8");
  const rendered = Effect.runSync(renderTemplate(w.worker, template, placeholderOverlay));
  const config = parseJsonc(rendered);
  findings.push(
    ...templateInvariants(w.worker, parseJsonc(template)),
    ...unrenderedCheck(w.worker, rendered),
    ...bindingCheck(w.worker, config, w.bindings),
    ...admissionCapCheck(w.worker, config),
    ...architectureFindings(w.worker, config, CURRENT_PHASE),
  );
  if (out !== undefined) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${w.worker}.jsonc`), rendered);
  }
}
findings.push(...Effect.runSync(profileCheck(profileDocumentFor("production"), validationContext)));
for (const f of findings) console.log(`${f.severity} ${f.check} ${f.path}: ${f.detail}`);
const failures = findings.filter((f) => f.severity === "failure").length;
console.log(`drift-check: ${failures} failure(s), ${findings.length - failures} warning(s)`);
process.exit(failures === 0 ? 0 : 1);
