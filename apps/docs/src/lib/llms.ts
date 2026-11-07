// The site sections /llms.txt and /llms-full.txt read, in sidebar order (nav.mjs).
import { getCollection } from "astro:content";
import { AREAS, sections } from "./nav.mjs";

export { AREAS };

export const SITE = new URL("https://flare-dispatch.fractalbox.dev");

// Mirrors REPO_URL in pages.mjs, which reads the file system at import and so cannot be imported
// from a prerendered page.
export const REPO_URL = "https://github.com/fractalboxdev/flare-dispatch";

/** Every section with its entries, in sidebar order. */
export const sectionEntries = async () => {
  const entries = await getCollection("docs");
  const byId = new Map(entries.map((e) => [e.id, e]));
  const readme = byId.get("specs")?.body ?? "";
  return sections(readme, [...byId.keys()]).map((section) => ({
    ...section,
    entries: section.ids.flatMap((id) => byId.get(id) ?? []),
  }));
};
