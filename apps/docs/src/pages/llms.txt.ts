// /llms.txt (https://llmstxt.org): the site index for language models, built from the
// docs content collection, in sidebar-section order.
import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { SECTIONS, SITE, sectionOf } from "../lib/llms";

export const GET: APIRoute = async ({ site }) => {
  const base = site ?? SITE;
  const entries = await getCollection("docs");
  const lines = [
    "# FlareDispatch",
    "",
    "> BYOC CI/CD that moves the expensive half of GitHub Actions onto a Cloudflare stack you own — Workflows for orchestration, Containers for execution, Browser Rendering for e2e, R2 for cache and artifacts. Runs are typed Effect-TS programs, not YAML. The substrate is its execution environment for agentic work, consumed only through a service-binding facade.",
    "",
    `The full text of every page is at ${new URL("/llms-full.txt", base).href}.`,
    "",
  ];
  for (const section of SECTIONS) {
    const pages = entries
      .filter((e) => sectionOf(e.id) === section.key)
      .sort((a, b) => a.id.split("/").length - b.id.split("/").length || a.id.localeCompare(b.id));
    if (pages.length === 0) continue;
    lines.push(`## ${section.title}`, "");
    for (const e of pages) {
      const url = new URL(e.id === "index" ? "/" : `/${e.id}/`, base).href;
      lines.push(`- [${e.data.title}](${url})${e.data.description ? `: ${e.data.description}` : ""}`);
    }
    lines.push("");
  }
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
