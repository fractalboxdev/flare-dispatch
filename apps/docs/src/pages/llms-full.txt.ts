// /llms-full.txt: the Markdown source of every docs page in one file, so a language model
// can read the whole site in one fetch.
import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { SITE, sectionRank } from "../lib/llms";

export const GET: APIRoute = async ({ site }) => {
  const base = site ?? SITE;
  const entries = (await getCollection("docs")).sort(
    (a, b) => sectionRank(a.id) - sectionRank(b.id) || a.id.localeCompare(b.id),
  );
  const parts = entries.map((e) => {
    const url = new URL(`/${e.id}/`, base).href;
    const body = (e.body ?? "").replace(/^# .*\n+/m, "").trim();
    return `# ${e.data.title}\n\nSource: ${url}\n\n${body}\n`;
  });
  return new Response(parts.join("\n---\n\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
