// @ts-check
// Sections of the docs site, in sidebar order. Each page is a file under specs/, named by
// its path without extension; `README` is the overview and `adr` the decision records.
// The sidebar (astro.config.mjs) and /llms.txt read this list.

/** @type {ReadonlyArray<{ key: string, title: string, pages: ReadonlyArray<string> }>} */
export const SECTIONS = [
  { key: "index", title: "Overview", pages: [""] },
  { key: "system", title: "System", pages: ["architecture", "run-model", "engine"] },
  { key: "admission", title: "Intake and admission", pages: ["intake", "qos-admission", "spend"] },
  {
    key: "execution",
    title: "Placement and execution",
    pages: ["placement-leases", "executor-protocol", "executors", "isolation-egress", "local-scheduler"],
  },
  { key: "outputs", title: "Outputs", pages: ["github-output", "cache-artifacts", "model-gateway", "provenance"] },
  { key: "runs", title: "Run catalog", pages: ["runs/gate", "runs/agentic"] },
  { key: "operating", title: "Operating", pages: ["interfaces", "operability"] },
  { key: "assurance", title: "Assurance", pages: ["verification", "roadmap"] },
  { key: "adr", title: "Decision records", pages: [] },
];

/** Section key of a docs collection id (`docs`, `docs/spend`, `docs/adr/0001-…`). */
export const sectionOf = (/** @type {string} */ id) => {
  const page = id.replace(/^docs\/?/, "");
  if (page === "adr" || page.startsWith("adr/")) return "adr";
  return SECTIONS.find((s) => s.pages.includes(page))?.key ?? "other";
};

/** Starlight sidebar built from SECTIONS. */
export const sidebar = () =>
  SECTIONS.map((s) => {
    if (s.key === "index") return { label: s.title, link: "/docs/" };
    if (s.key === "adr")
      return { label: s.title, collapsed: true, items: [{ autogenerate: { directory: "docs/adr" } }] };
    return { label: s.title, items: s.pages.map((p) => `docs/${p}`) };
  });
