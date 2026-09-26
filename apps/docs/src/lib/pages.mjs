// @ts-check
// Repository Markdown on the site. Every page under src/content/docs/ except the docs
// overview (docs/index.mdx) is a relative symbolic link into the repository (a guide, a
// README, a spec), so each file has one copy and reads the same on GitHub and here. This
// module supplies what Starlight needs and GitHub does not: ids, titles, descriptions,
// and site URLs for the relative links those files contain.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root and the docs content root, both real paths. */
export const REPO = realpathSync(fileURLToPath(new URL("../../../../", import.meta.url)));
const CONTENT = realpathSync(fileURLToPath(new URL("../content/docs/", import.meta.url)));
/** Where links to repository files that are not pages point. */
export const REPO_URL = "https://github.com/fractalboxdev/flare-dispatch";

const slugify = (/** @type {string} */ segment) =>
  segment
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");

/**
 * Collection id of a docs entry: the path without extension, slugified per segment;
 * `README` and `index` name their directory.
 * @param {{ entry: string, data: Record<string, unknown> }} options
 */
export const pageId = ({ entry, data }) => {
  if (typeof data.slug === "string") return data.slug;
  const parts = entry.replace(/\.(md|mdx)$/i, "").split("/");
  if (/^(readme|index)$/i.test(parts[parts.length - 1] ?? "")) parts.pop();
  return parts.map(slugify).join("/") || "index";
};

/** Site path of a collection id. */
export const pagePath = (/** @type {string} */ id) => (id === "index" ? "/" : `/${id}/`);

/**
 * Real path of every page → its site path, walked through the symbolic links the
 * content root holds.
 * @type {Map<string, string>}
 */
export const PAGES = (() => {
  /** @type {Map<string, string>} */
  const pages = new Map();
  const walk = (/** @type {string} */ dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.mdx?$/i.test(name)) {
        const entry = relative(CONTENT, p).split(sep).join("/");
        pages.set(realpathSync(p), pagePath(pageId({ entry, data: {} })));
      }
    }
  };
  walk(CONTENT);
  return pages;
})();

/**
 * Site paths of pages whose source is a README.md. starlight-links-validator keys pages by
 * file name, so it reports links to these directory indexes as invalid.
 */
export const README_PAGES = new Set([...PAGES].filter(([real]) => /\/README\.md$/i.test(real)).map(([, path]) => path));

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

/** Cuts a description to at most 160 characters at a word boundary. */
const clip = (/** @type {string} */ s) => (s.length <= 160 ? s : `${s.slice(0, 157).replace(/\s+\S*$/, "")}…`);

/**
 * Front matter for an entry: a missing `title` comes from the first `# heading`, a
 * missing `description` from the first paragraph. Entries with their own front matter
 * pass through unchanged.
 * @template {Record<string, unknown>} T
 * @param {T} data
 * @param {string | undefined} filePath
 * @returns {T}
 */
export const pageFrontmatter = (data, filePath) => {
  if ((data.title && data.description) || !filePath) return data;
  const { title, lead } = headingAndLead(readFileSync(filePath, "utf8"));
  return {
    ...data,
    ...(data.title ? {} : { title: title ?? filePath.split("/").pop() }),
    ...(data.description || !lead ? {} : { description: clip(lead) }),
  };
};

const inside = (/** @type {string} */ base, /** @type {string} */ p) => p === base || p.startsWith(base + sep);

/**
 * Site URL of a relative link written in the repository file `realFile`: a page → its
 * site path; a directory whose README is a page → that page; anything else in the
 * repository → GitHub. Returns null for links left alone (absolute, external, anchors).
 * @param {string} href
 * @param {string} realFile
 */
export const pageHref = (href, realFile) => {
  if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) return null;
  const [path = "", hash = ""] = href.split(/(?=#)/);
  const target = resolve(dirname(realFile), decodeURI(path));
  if (!inside(REPO, target)) return null;
  const isDir = existsSync(target) && statSync(target).isDirectory();
  const page = PAGES.get(isDir ? resolve(target, "README.md") : target);
  if (page) return `${page}${hash}`;
  const repoRel = relative(REPO, target).split(sep).join("/");
  return `${REPO_URL}/${isDir ? "tree" : "blob"}/main/${repoRel}${hash}`;
};

/** Real path of a repository page, or null for the docs overview and non-files. */
const repoFile = (/** @type {URL | undefined} */ fileURL) => {
  if (!fileURL) return null;
  try {
    const real = realpathSync(fileURLToPath(fileURL));
    return inside(REPO, real) && !inside(CONTENT, real) ? real : null;
  } catch {
    return null;
  }
};

/**
 * Sätteri hast plugin factory: in repository files, rewrites relative links to site URLs
 * so links written for GitHub work on the site, and drops the first `# heading`, because
 * Starlight renders the title from front matter. The docs overview is left alone.
 * @param {{ fileURL?: URL }} ctx
 */
export const repoLinks = ({ fileURL } = {}) => {
  const real = repoFile(fileURL);
  if (!real) return null;
  let droppedTitle = false;
  return {
    name: "flare-dispatch-docs-repo-links",
    element: [
      {
        filter: ["a"],
        /** @param {any} node @param {any} ctx */
        visit(node, ctx) {
          const href = pageHref(String(node.properties?.href ?? ""), real);
          if (href) ctx.setProperty(node, "href", href);
        },
      },
      {
        filter: ["h1"],
        /** @param {any} node @param {any} ctx */
        visit(node, ctx) {
          if (droppedTitle) return;
          droppedTitle = true;
          ctx.removeNode(node);
        },
      },
    ],
  };
};
