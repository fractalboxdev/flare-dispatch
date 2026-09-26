// Section order shared by /llms.txt and /llms-full.txt — the sidebar's order.
export const SECTIONS = [
  { key: "index", title: "Overview" },
  { key: "actions", title: "GitHub Actions" },
  { key: "runs", title: "Run catalog" },
  { key: "substrate", title: "Substrate guides" },
  { key: "reference", title: "API reference" },
  { key: "design", title: "Design records" },
] as const;

// Docs ids live under `docs/`; the section is the segment after it, and `docs` itself is
// the overview.
export const sectionOf = (id: string): string => id.replace(/^docs\/?/, "").split("/")[0] || "index";

export const sectionRank = (id: string): number => {
  const i = SECTIONS.findIndex((s) => s.key === sectionOf(id));
  return i < 0 ? SECTIONS.length : i;
};

export const SITE = new URL("https://flare-dispatch.fractalbox.dev");

// Mirrors REPO_URL in pages.mjs, which walks the content tree at import and so cannot be
// imported from a prerendered page.
export const REPO_URL = "https://github.com/fractalboxdev/flare-dispatch";
