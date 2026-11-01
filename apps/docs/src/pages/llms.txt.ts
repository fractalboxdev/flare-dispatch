// /llms.txt (https://llmstxt.org): the site index for language models, built from the
// docs content collection, in sidebar-section order.
import type { APIRoute } from "astro";
import { AREAS, SITE, sectionEntries } from "../lib/llms";

export const GET: APIRoute = async ({ site }) => {
  const base = site ?? SITE;
  const lines = [
    "# FlareDispatch",
    "",
    "> Run CI, tasks and agents anywhere. Securely. Three states apply: v1 deploys today into your own Cloudflare account and runs CI, scheduled tasks and agents on Cloudflare Workflows and Containers; a local v2 run works in development only, through `pnpm dogfood` on an unmerged pull request, with its jobs on the host; v2 placement across owned machines, Cloudflare and AWS, and job isolation on a device, are specified and not built.",
    "",
    "The Documentation sections describe what deploys today. The Specifications sections state the requirements and decisions of v2, and describe its target behaviour, not shipped behaviour.",
    "",
    `The full text of every page is at ${new URL("/llms-full.txt", base).href}.`,
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
