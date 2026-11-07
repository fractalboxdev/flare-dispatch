// /llms-full.txt: the Markdown source of every docs page in one file, so a language model
// can read the whole site in one fetch.
import type { APIRoute } from "astro";
import { SITE, sectionEntries } from "../lib/llms";

export const GET: APIRoute = async ({ site }) => {
  const base = site ?? SITE;
  const parts = (await sectionEntries())
    .flatMap((s) => s.entries)
    .map((e) => {
      const url = new URL(`/${e.id}/`, base).href;
      const body = (e.body ?? "").replace(/^# .*\n+/m, "").trim();
      return `# ${e.data.title}\n\nSource: ${url}\n\n${body}\n`;
    });
  return new Response(parts.join("\n---\n\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
