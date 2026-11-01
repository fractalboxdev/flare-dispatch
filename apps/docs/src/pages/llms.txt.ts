// /llms.txt (https://llmstxt.org): the site index for language models, built from the
// docs content collection, in sidebar-section order.
import type { APIRoute } from "astro";
import { AREAS, SITE, sectionEntries } from "../lib/llms";

export const GET: APIRoute = async ({ site }) => {
  const base = site ?? SITE;
  const lines = [
    "# FlareDispatch",
    "",
    "> Run CI, tasks and agents anywhere. Securely. FlareDispatch is CI/CD you deploy into your own Cloudflare account.",
    "",
    "The Documentation sections describe what deploys today. The Specifications sections state the requirements and decisions of v2, and describe its target behaviour, not shipped behaviour. The Roadmap section states how much of v2 exists.",
    "",
    `The full text of every page is at ${new URL("/llms-full.txt", base).href}.`,
    "",
    "## Roadmap",
    "",
    `- [Roadmap and status](${new URL("/roadmap/", base).href}): what deploys today, what runs in development and what is specified, with the phases and their goals.`,
    "",
  ];
  for (const section of await sectionEntries()) {
    lines.push(`## ${AREAS[section.area]}: ${section.title}`, "");
    for (const e of section.entries) {
      const url = new URL(`/${e.id}/`, base).href;
      lines.push(`- [${e.data.title}](${url})${e.data.description ? `: ${e.data.description}` : ""}`);
    }
    lines.push("");
  }
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
