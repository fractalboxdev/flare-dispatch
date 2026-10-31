// Mermaid to SVG for the landing page, through the same Merlion WASM module that renders
// the docs' ```mermaid blocks (astro.config.mjs). Runs at build time only; the page ships
// the SVG and no script. A diagram that fails to render, or renders with a warning or a
// repair, fails the build.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initSync, render } from "@fractalbox/merlion-wasm";

let ready = false;

const init = () => {
  if (ready) return;
  const require = createRequire(import.meta.url);
  initSync(readFileSync(require.resolve("@fractalbox/merlion-wasm/merlion.wasm")));
  ready = true;
};

/** The diagram's SVG; `id` is its root id and prefixes every inner id on the page. */
export const renderDiagram = (source: string, id: string, width: number): string => {
  init();
  const result = render(source, { width, idPrefix: id, strict: true });
  const problems = result.diagnostics.filter((d) => d.severity !== "info");
  if (result.svg === null || problems.length > 0) {
    const detail = problems.map((d) => `${d.code} ${d.line}:${d.column} ${d.message}`).join("; ");
    throw new Error(`merlion: diagram "${id}" failed (${result.error?.kind ?? "diagnostics"}): ${detail}`);
  }
  return result.svg;
};
