// Section order shared by /llms.txt and /llms-full.txt — the sidebar's order (nav.mjs).
import { SECTIONS, sectionOf } from "./nav.mjs";

export { SECTIONS, sectionOf };

export const sectionRank = (id: string): number => {
  const i = SECTIONS.findIndex((s) => s.key === sectionOf(id));
  return i < 0 ? SECTIONS.length : i;
};

export const SITE = new URL("https://flare-dispatch.fractalbox.dev");

// Mirrors REPO_URL in pages.mjs, which walks the content tree at import and so cannot be
// imported from a prerendered page.
export const REPO_URL = "https://github.com/fractalboxdev/flare-dispatch";
