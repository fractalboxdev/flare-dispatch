// @ts-check
// The sections of the site, in sidebar order, for the sidebar (astro.config.mjs), /llms.txt and
// /llms-full.txt. The `/docs/` sections are listed here; the `/specs/` sections derive from the
// index table in specs/README.md and from the ADR files. `sections` throws when a page belongs to
// no section, so a new file cannot go missing from the sidebar.
import { areaFiles, sidebarLabelOf, specId } from "./specs.mjs";

export const AREAS = /** @type {const} */ ({ docs: "Documentation", specs: "Specifications" });

/**
 * @typedef {object} Section
 * @property {keyof typeof AREAS} area The area the section belongs to.
 * @property {string} title The section's title.
 * @property {boolean} [open] The sidebar shows the section's pages without a group of their own.
 * @property {boolean} [collapsed] The sidebar collapses the section.
 * @property {ReadonlyArray<string>} ids The section's content ids, in order.
 */

/** @type {ReadonlyArray<Section>} */
const DOCS_SECTIONS = [
  { area: "docs", title: "Overview", open: true, ids: ["docs", "docs/v2"] },
  {
    area: "docs",
    title: "GitHub Actions",
    ids: ["docs/actions", "docs/actions/flare-dispatch-action", "docs/actions/deploy-dispatcher-action"],
  },
  { area: "docs", title: "Run catalog", open: true, ids: ["docs/runs"] },
  {
    area: "docs",
    title: "Substrate guides",
    ids: [
      "docs/substrate",
      "docs/substrate/facade",
      "docs/substrate/grant-profiles",
      "docs/substrate/byoc-upgrade",
      "docs/substrate/contract-versioning",
    ],
  },
  { area: "docs", title: "API reference", ids: ["docs/reference/substrate-contract"] },
];

/**
 * Every section of the site.
 * @param {string} readme The text of `specs/README.md`.
 * @param {ReadonlyArray<string>} ids The content id of every page.
 * @returns {ReadonlyArray<Section>}
 */
export const sections = (readme, ids) => {
  /** @type {ReadonlyArray<Section>} */
  const all = [
    ...DOCS_SECTIONS,
    {
      area: "docs",
      title: "Substrate design records",
      collapsed: true,
      ids: ids.filter((id) => id.startsWith("docs/design/substrate")).sort(),
    },
    { area: "specs", title: "Overview", open: true, ids: ["specs"] },
    { area: "specs", title: "Areas", ids: areaFiles(readme).map(specId) },
    { area: "specs", title: "Roadmap", open: true, ids: [specId("roadmap.md")] },
    {
      area: "specs",
      title: "Decision records",
      collapsed: true,
      ids: ["specs/adr", ...ids.filter((id) => /^specs\/adr\/\d{4}-/.test(id)).sort()],
    },
  ];
  const placed = new Set(all.flatMap((s) => s.ids));
  const outside = ids.filter((id) => !placed.has(id));
  if (outside.length > 0) throw new Error(`pages outside the sidebar: ${outside.join(", ")}`);
  const known = new Set(ids);
  const absent = [...placed].filter((id) => !known.has(id));
  if (absent.length > 0) throw new Error(`sidebar names missing pages: ${absent.join(", ")}`);
  return all;
};

/** @typedef {{ slug: string, label?: string }} SidebarLink */
/** @typedef {{ label: string, collapsed: boolean, items: SidebarLink[] }} SidebarGroup */

/**
 * The Starlight sidebar: one collapsed group per area, which Starlight opens on the pages of that
 * area.
 * @param {ReadonlyArray<Section>} all
 * @param {ReadonlyMap<string, string | undefined>} titles Content id → first heading.
 */
export const sidebar = (all, titles) => {
  /** @returns {SidebarLink} */
  const item = (/** @type {string} */ slug) => {
    const label = sidebarLabelOf(slug, titles.get(slug));
    return label === undefined ? { slug } : { slug, label };
  };
  /** @returns {Array<SidebarLink | SidebarGroup>} */
  const entry = (/** @type {Section} */ s) =>
    s.open ? s.ids.map(item) : [{ label: s.title, collapsed: s.collapsed ?? false, items: s.ids.map(item) }];
  const entries = (/** @type {keyof typeof AREAS} */ area) => all.filter((s) => s.area === area).flatMap(entry);
  return [
    { label: AREAS.docs, collapsed: true, items: entries("docs") },
    { label: AREAS.specs, collapsed: true, items: entries("specs") },
  ];
};
