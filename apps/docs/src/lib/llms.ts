// Section order shared by /llms.txt and /llms-full.txt — the sidebar's order.
export const SECTIONS = [
  { key: "index", title: "Overview" },
  { key: "actions", title: "GitHub Actions" },
  { key: "runs", title: "Run catalog" },
  { key: "substrate", title: "Substrate guides" },
  { key: "reference", title: "API reference" },
  { key: "design", title: "Design records" },
] as const;

export const sectionOf = (id: string): string => id.split("/")[0] ?? id;

export const sectionRank = (id: string): number => {
  const i = SECTIONS.findIndex((s) => s.key === sectionOf(id));
  return i < 0 ? SECTIONS.length : i;
};

export const SITE = new URL("https://flare-dispatch.fractalbox.dev");
