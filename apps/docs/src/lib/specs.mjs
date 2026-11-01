// @ts-check
// Routes, titles and link targets of repository Markdown. Everything here is a pure function of
// its arguments, so prerendered pages may import this module; pages.mjs holds the file system
// side.
import { posix } from "node:path";

/** The route prefix every specification page sits under. */
export const SPECS_ROUTE = "specs";

const slugify = (/** @type {string} */ segment) =>
  segment
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");

/**
 * The content id of the file `entry` of a mount at `route`: the path without extension, slugified
 * per segment; `README` and `index` name their directory.
 * @param {string} route
 * @param {string} entry
 */
export const pageId = (route, entry) => {
  const parts = entry.replace(/\.md$/i, "").split("/");
  if (/^(readme|index)$/i.test(parts.at(-1) ?? "")) parts.pop();
  return [route, ...parts.map(slugify)].join("/");
};

/**
 * The content id of a file named by its path relative to `specs/`.
 * @param {string} rel
 */
export const specId = (rel) => pageId(SPECS_ROUTE, rel);

/**
 * The site route of a content id.
 * @param {string} id
 */
export const pagePath = (id) => `/${id}/`;

/** Markdown inline syntax to plain text, for titles and descriptions. */
const plain = (/** @type {string} */ s) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The first `# heading` and the first paragraph of a Markdown file.
 * @param {string} text
 */
export const headingAndLead = (text) => {
  const lines = text.replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
  const h = lines.findIndex((l) => /^# /.test(l));
  const title = h >= 0 ? plain(lines[h].slice(2)) : undefined;
  let lead;
  for (let i = h + 1, para = []; i <= lines.length; i++) {
    const l = lines[i] ?? "";
    if (l.trim() === "" || /^(#|```|\||- |\d+\. |>|<)/.test(l)) {
      if (para.length) {
        lead = plain(para.join(" "));
        break;
      }
      continue;
    }
    para.push(l);
  }
  return { title, lead };
};

/**
 * The page title of a Markdown file: its first `# ` heading as plain text.
 * @param {string} text
 */
export const titleOf = (text) => headingAndLead(text).title;

/** Sidebar labels of pages whose heading names their directory or package. */
const FIXED_LABELS = /** @type {Readonly<Record<string, string>>} */ ({
  specs: "Glossary and index",
  "specs/adr": "Decision index",
  "docs/design/substrate": "Index",
  "docs/design/substrate/adr": "Decision index",
  "docs/reference/substrate-contract": "Substrate facade",
});

/**
 * The sidebar label of a page: a fixed label where one exists, an ADR's title without its `ADR-`
 * prefix and with its number, and otherwise the title.
 * @param {string} id
 * @param {string | undefined} title
 */
export const sidebarLabelOf = (id, title) => {
  const fixed = FIXED_LABELS[id];
  if (fixed !== undefined) return fixed;
  const adr = /^ADR-(\d{4}): (.+)$/.exec(title ?? "");
  return adr ? `${adr[1]} · ${adr[2]}` : title;
};

/** @typedef {{ readonly href: string } | { readonly error: string }} LinkTarget */

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * The site route for a link written in the specification file at `fromRel` (relative to
 * `specs/`). External links and same-page anchors return unchanged; a relative link to another
 * specification file returns that file's route with its anchor; a site path, a link that leaves
 * `specs/` and a link that names a missing file return an error.
 * @param {string} url
 * @param {string} fromRel
 * @param {(rel: string) => boolean} exists
 * @returns {LinkTarget}
 */
export const linkTarget = (url, fromRel, exists) => {
  if (url === "" || url.startsWith("#") || EXTERNAL.test(url)) return { href: url };
  const hashAt = url.indexOf("#");
  const path = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  if (path.startsWith("/")) return { error: `absolute path ${url} in a specification file` };
  const target = posix.normalize(posix.join(posix.dirname(fromRel), decodeURIComponent(path)));
  if (target.startsWith("..")) return { error: `${url} leaves specs/` };
  const file = target.endsWith(".md") ? target : posix.join(target, "README.md");
  if (!exists(file)) return { error: `${url} names ${file}, which is not under specs/` };
  return { href: `${pagePath(specId(file))}${hash}` };
};

/**
 * The phase table in `specs/roadmap.md`: each phase with its goal and requirement count, and the
 * total. Throws when the table is not there, so a changed table fails the build.
 * @param {string} roadmap The text of `specs/roadmap.md`.
 */
export const phaseTable = (roadmap) => {
  const phases = [...roadmap.matchAll(/^\| (\d+) \| (.+?) \| (\d+) \| (.+?) \| (.+?) \|$/gm)].map((m) => ({
    phase: Number(m[1]),
    goal: (m[2] ?? "").replace(/`/g, ""),
    requirements: Number(m[3]),
    waitsOn: (m[4] ?? "").replace(/`/g, ""),
  }));
  const total = /^\| All \| \| (\d+) \|/m.exec(roadmap)?.[1];
  if (phases.length === 0 || total === undefined) throw new Error("no phase table in specs/roadmap.md");
  return { phases, total: Number(total) };
};

/**
 * The files of the index table in `specs/README.md`, in table order. `roadmap.md` has its own
 * sidebar group.
 * @param {string} readme
 */
export const areaFiles = (readme) =>
  [...readme.matchAll(/^\| \[([a-z/-]+\.md)\]\(\1\) \|/gm)].map((m) => m[1] ?? "").filter((f) => f !== "roadmap.md");
