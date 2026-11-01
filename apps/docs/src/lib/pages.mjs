// @ts-check
// Repository Markdown on the site. Each mount names a repository directory and the route its files
// serve at; the content loader (src/content.config.ts) reads them in place, so each file has one
// copy and reads the same on GitHub and here. This module supplies what Starlight needs and GitHub
// does not: ids, titles, descriptions, and site URLs for the relative links those files contain.
//
// It reads the file system at import, relative to its own URL, so a prerendered page cannot import
// it; src/lib/specs.mjs and src/lib/nav.mjs hold what those pages need.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport } from "./build-report.mjs";
import { sections, sidebar } from "./nav.mjs";
import { headingAndLead, linkTarget, pageId, pagePath, titleOf } from "./specs.mjs";

/** The repository root, as a real path. */
export const REPO = realpathSync(fileURLToPath(new URL("../../../../", import.meta.url)));
/** Where links to repository files that are not pages point. */
export const REPO_URL = "https://github.com/fractalboxdev/flare-dispatch";
/** The repository's `specs/` directory, with a trailing separator. */
export const SPECS_DIR = join(REPO, "specs") + sep;

/**
 * @typedef {object} Mount
 * @property {string} dir Repository-relative directory.
 * @property {string} route Route prefix of its pages.
 * @property {ReadonlyArray<string>} [files] Files to publish; every Markdown file when absent.
 */

/** @type {ReadonlyArray<Mount>} */
export const MOUNTS = [
  { dir: "specs", route: "specs" },
  { dir: "apps/docs/src/content/docs/docs", route: "docs" },
  { dir: "apps/docs/substrate", route: "docs/substrate" },
  { dir: "apps/docs/reference", route: "docs/reference" },
  { dir: "apps/substrate/specs", route: "docs/design/substrate" },
  { dir: "runs", route: "docs/runs", files: ["README.md"] },
  {
    dir: "actions",
    route: "docs/actions",
    files: ["README.md", "flare-dispatch-action/README.md", "deploy-dispatcher-action/README.md"],
  },
];

/**
 * Every published file of a mount, relative to the mount's directory.
 * @param {Mount} mount
 * @returns {ReadonlyArray<string>}
 */
const mountFiles = (mount) =>
  mount.files ??
  readdirSync(join(REPO, mount.dir), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.split(sep).join("/"));

/**
 * Real path of every page → its content id.
 * @type {ReadonlyMap<string, string>}
 */
export const PAGES = new Map(
  MOUNTS.flatMap((mount) =>
    mountFiles(mount).map((entry) => {
      /** @type {[string, string]} */
      const page = [join(REPO, mount.dir, entry), pageId(mount.route, entry)];
      return page;
    }),
  ),
);

/** The Starlight sidebar. Throws when a page belongs to no section. */
export const siteSidebar = () => {
  const readme = readFileSync(join(SPECS_DIR, "README.md"), "utf8");
  const titles = new Map([...PAGES].map(([file, id]) => [id, titleOf(readFileSync(file, "utf8"))]));
  return sidebar(sections(readme, [...titles.keys()]), titles);
};

/** Cuts a description to at most 160 characters at a word boundary. */
const clip = (/** @type {string} */ s) => (s.length <= 160 ? s : `${s.slice(0, 157).replace(/\s+\S*$/, "")}…`);

/** The banner on every specification page. */
const SPEC_BANNER = {
  content:
    'This page specifies FlareDispatch v2, which is partly built. <a href="/docs/v2/">v1 and v2</a> states what deploys today.',
};

/**
 * Front matter for an entry: a missing `title` comes from the first `# heading`, a missing
 * `description` from the first paragraph, and a specification page carries the v2 banner. A
 * Markdown file with neither a title nor a heading throws.
 * @template {Record<string, unknown>} T
 * @param {T} data
 * @param {string | undefined} filePath
 * @param {string} id
 */
export const pageFrontmatter = (data, filePath, id) => {
  const { title, lead } = headingAndLead(filePath ? readFileSync(filePath, "utf8") : "");
  if (!data.title && !title) throw new Error(`${id}: no first-level heading to take a title from`);
  return {
    ...data,
    ...(data.title ? {} : { title }),
    ...(data.description || !lead ? {} : { description: clip(lead) }),
    ...(id === "specs" || id.startsWith("specs/") ? { banner: SPEC_BANNER } : {}),
  };
};

const inside = (/** @type {string} */ base, /** @type {string} */ p) => p === base || p.startsWith(base + sep);

/**
 * Site URL of a relative link written in the repository file `realFile`: a page → its site path; a
 * directory whose README is a page → that page; any other repository file → GitHub. Absolute,
 * external and same-page links return unchanged, and a relative link that leaves the repository or
 * names a missing file returns an error.
 * @param {string} href
 * @param {string} realFile
 * @returns {import("./specs.mjs").LinkTarget}
 */
export const pageHref = (href, realFile) => {
  if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) return { href };
  const [path = "", hash = ""] = href.split(/(?=#)/);
  const target = resolve(dirname(realFile), decodeURI(path));
  if (!inside(REPO, target)) return { error: `${href} leaves the repository` };
  if (!existsSync(target)) return { error: `${href} names a missing file` };
  const isDir = statSync(target).isDirectory();
  const page = PAGES.get(isDir ? resolve(target, "README.md") : target);
  if (page) return { href: `${pagePath(page)}${hash}` };
  const repoRel = relative(REPO, target).split(sep).join("/");
  return { href: `${REPO_URL}/${isDir ? "tree" : "blob"}/main/${repoRel}${hash}` };
};

/**
 * The target of a link in the page at `realFile`. Links in `specs/` stay in `specs/`, under
 * `linkTarget`; links in every other page follow `pageHref`.
 * @param {string} href
 * @param {string} realFile
 * @returns {import("./specs.mjs").LinkTarget}
 */
const resolveLink = (href, realFile) =>
  realFile.startsWith(SPECS_DIR)
    ? linkTarget(href, realFile.slice(SPECS_DIR.length), (rel) => existsSync(join(SPECS_DIR, rel)))
    : pageHref(href, realFile);

/** Real path of the file behind a Markdown render, or undefined for a render with no file. */
const realFile = (/** @type {URL | undefined} */ fileURL) => {
  if (!fileURL) return undefined;
  try {
    return realpathSync(fileURLToPath(fileURL));
  } catch {
    return undefined;
  }
};

/**
 * Sätteri hast plugin factory for pages: rewrites relative links to site URLs so links written for
 * GitHub work on the site, records a broken link in the build report, and drops the first
 * `# heading`, because Starlight renders the title from front matter.
 * @param {{ fileURL?: URL }} ctx
 */
export const repoLinks = ({ fileURL } = {}) => {
  const file = realFile(fileURL);
  const id = file === undefined ? undefined : PAGES.get(file);
  if (file === undefined || id === undefined) return null;
  let droppedTitle = false;
  return {
    name: "flare-dispatch-docs-repo-links",
    /** @param {unknown} _root @param {any} ctx */
    before(_root, ctx) {
      // starlight-links-validator keys a page by its path under src/content/docs unless its front
      // matter names a slug. A mounted file sits outside that directory.
      const frontmatter = ctx.data.astro?.frontmatter;
      if (frontmatter) frontmatter.slug = id;
    },
    element: [
      {
        filter: ["a"],
        /** @param {any} node @param {any} ctx */
        visit(node, ctx) {
          const href = String(node.properties?.href ?? "");
          const target = resolveLink(href, file);
          if ("error" in target) buildReport().problems.push(`${relative(REPO, file)}: broken link: ${target.error}`);
          else if (target.href !== href) ctx.setProperty(node, "href", target.href);
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
