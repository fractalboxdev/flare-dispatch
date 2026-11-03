// @ts-check
// The site check: an Astro integration that fails the build when an internal link or anchor in the
// built HTML has no target, when a page has no built HTML, when a specification diagram did not
// render, or when the Markdown plugin recorded a problem. It logs the page count and the diagram
// count of every build.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport } from "./build-report.mjs";
import { pagePath } from "./specs.mjs";

/** @returns {string[]} */
const walk = (/** @type {string} */ dir, /** @type {string[]} */ out = []) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
};

/** @type {Readonly<Record<string, string>>} */
const ENTITIES = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" };
const unescape = (/** @type {string} */ s) => s.replace(/&(?:amp|quot|#39|lt|gt);/g, (e) => ENTITIES[e] ?? e);

const MERLION_SVG = /<svg\b[^>]*\bclass="[^"]*\bmerlion\b/g;
const MERMAID_FENCE = /^```mermaid\s*$/gm;

/** The route of a built HTML file: `specs/spend/index.html` is `/specs/spend/`. */
const routeOf = (/** @type {string} */ outDir, /** @type {string} */ file) =>
  `/${relative(outDir, file)
    .split(sep)
    .join("/")
    .replace(/(^|\/)index\.html$/, "$1")}`;

/** The built file a site path names, or undefined when none exists. */
const fileOf = (/** @type {string} */ outDir, /** @type {string} */ pathname) => {
  const path = decodeURIComponent(pathname);
  const candidates = path.endsWith("/")
    ? [join(outDir, path, "index.html")]
    : [join(outDir, path), join(outDir, path, "index.html"), join(outDir, `${path}.html`)];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile());
};

/**
 * @param {{ pages: ReadonlyMap<string, string>, specsDir: string }} options `pages` maps the path
 *   of every source file to its content id.
 * @returns {import("astro").AstroIntegration}
 */
export const siteCheck = ({ pages, specsDir }) => ({
  name: "flare-dispatch-docs-site-check",
  hooks: {
    "astro:build:done": ({ dir, logger }) => {
      const outDir = fileURLToPath(dir);
      const html = new Map(
        walk(outDir)
          .filter((f) => f.endsWith(".html"))
          .map((p) => [p, readFileSync(p, "utf8")]),
      );
      /** @type {Map<string, Set<string>>} */
      const ids = new Map();
      for (const [page, text] of html)
        ids.set(page, new Set([...text.matchAll(/\sid="([^"]+)"/g)].map((m) => unescape(m[1] ?? ""))));

      const problems = [...buildReport().problems];
      let links = 0;
      for (const [page, text] of html) {
        const from = routeOf(outDir, page);
        const base = new URL(from, "https://site.invalid");
        for (const m of text.matchAll(/<a\b[^>]*?\shref="([^"]*)"/g)) {
          const href = unescape(m[1] ?? "");
          if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue;
          links += 1;
          const url = new URL(href, base);
          const target = url.pathname === base.pathname ? page : fileOf(outDir, url.pathname);
          if (target === undefined) {
            problems.push(`${from}: link ${href} has no page`);
            continue;
          }
          const fragment = decodeURIComponent(url.hash.slice(1));
          if (fragment === "" || fragment === "_top" || !target.endsWith(".html")) continue;
          if (!ids.get(target)?.has(fragment)) problems.push(`${from}: link ${href} has no anchor #${fragment}`);
        }
        if (/data-language="mermaid"|language-mermaid/.test(text)) problems.push(`${from}: a mermaid block left unrendered`);
      }

      const routes = new Set([...html.keys()].map((p) => routeOf(outDir, p)));
      for (const route of ["/", "/benchmarks/", "/roadmap/"])
        if (!routes.has(route)) problems.push(`no page at ${route}`);
      for (const [file, id] of pages)
        if (!routes.has(pagePath(id))) problems.push(`${relative(specsDir, file)} has no page at ${pagePath(id)}`);

      const diagrams = (/** @type {(route: string) => boolean} */ pred) =>
        [...html]
          .filter(([p]) => pred(routeOf(outDir, p)))
          .reduce((n, [, t]) => n + (t.match(MERLION_SVG)?.length ?? 0), 0);
      const specFiles = walk(specsDir).filter((f) => f.endsWith(".md"));
      const specFences = specFiles.reduce((n, f) => n + (readFileSync(f, "utf8").match(MERMAID_FENCE)?.length ?? 0), 0);
      const specDiagrams = diagrams((r) => r.startsWith("/specs/"));
      const docDiagrams = diagrams((r) => r.startsWith("/docs/"));
      const specPages = [...routes].filter((r) => r.startsWith("/specs/")).length;
      const docPages = [...routes].filter((r) => r.startsWith("/docs/")).length;
      if (specDiagrams !== specFences)
        problems.push(`${specFences} mermaid blocks under specs/, ${specDiagrams} rendered diagrams on /specs/ pages`);
      if (specPages !== specFiles.length) problems.push(`${specFiles.length} specification files, ${specPages} pages under /specs/`);

      logger.info(
        `${html.size} pages (${docPages} under /docs/, ${specPages} under /specs/), ${specDiagrams + docDiagrams} diagrams (${docDiagrams} on /docs/, ${specDiagrams} on /specs/), ${links} internal links`,
      );
      if (problems.length > 0) {
        for (const p of problems) logger.error(p);
        throw new Error(`site check: ${problems.length} problems`);
      }
    },
  },
});
