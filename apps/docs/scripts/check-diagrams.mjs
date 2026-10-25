// Renders every ```mermaid block of the given Markdown files through Merlion and prints each
// error, warning and repair as file:line. Exits 1 when any block fails to render or needs a
// repair. With --fix, applies Merlion's repairs to the files in place. Merlion renders
// flowchart, sequenceDiagram and stateDiagram-v2; any other header fails with E003.
//
//   node apps/docs/scripts/check-diagrams.mjs [--fix] specs/**/*.md
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initSync, render } from "@fractalbox/merlion-wasm";

const require = createRequire(import.meta.url);
initSync(readFileSync(require.resolve("@fractalbox/merlion-wasm/merlion.wasm")));

const FENCE = /^```mermaid\s*\n([\s\S]*?)^```\s*$/gm;
const args = process.argv.slice(2);
const fix = args.includes("--fix");
let failed = 0;
let repairs = 0;
let blocks = 0;

/** Applies diagnostic fixes, given in UTF-8 byte offsets, to one diagram source. */
const applyFixes = (/** @type {string} */ source, /** @type {any[]} */ fixes) => {
  let bytes = Buffer.from(source, "utf8");
  for (const f of [...fixes].sort((a, b) => b.byteStart - a.byteStart)) {
    bytes = Buffer.concat([bytes.subarray(0, f.byteStart), Buffer.from(f.replacement, "utf8"), bytes.subarray(f.byteEnd)]);
  }
  return bytes.toString("utf8");
};

for (const file of args.filter((a) => a !== "--fix")) {
  const text = readFileSync(file, "utf8");
  let out = text;
  for (const match of [...text.matchAll(FENCE)].reverse()) {
    blocks += 1;
    const source = match[1];
    const startLine = text.slice(0, match.index).split("\n").length + 1;
    const result = render(source, { width: 720 });
    const fixes = result.diagnostics.filter((d) => d.severity === "repair" && d.fix).map((d) => d.fix);
    for (const d of result.diagnostics.filter((d) => d.severity !== "info")) {
      console.log(`${file}:${startLine + Math.max(d.line, 1) - 1}: ${d.severity} ${d.code} ${d.message}`);
    }
    if (result.error || result.svg === null) {
      failed += 1;
      console.log(`${file}:${startLine}: failed (${result.error?.kind ?? "no svg"})`);
    }
    if (fixes.length > 0) {
      repairs += fixes.length;
      if (fix) {
        const start = (match.index ?? 0) + match[0].indexOf(source);
        out = out.slice(0, start) + applyFixes(source, fixes) + out.slice(start + source.length);
      }
    }
  }
  if (fix && out !== text) writeFileSync(file, out);
}

console.log(`${blocks} diagrams, ${failed} failed, ${repairs} repairs${fix ? " applied" : ""}`);
process.exit(failed > 0 || (repairs > 0 && !fix) ? 1 : 0);
