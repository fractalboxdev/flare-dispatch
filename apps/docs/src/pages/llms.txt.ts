// /llms.txt (https://llmstxt.org): the site index for language models, built from the
// docs content collection, in sidebar-section order.
import type { APIRoute } from "astro";
import { AREAS, SITE, sectionEntries } from "../lib/llms";

export const GET: APIRoute = async ({ site }) => {
  const base = site ?? SITE;
  const lines = [
    "# FlareDispatch",
    "",
    "> BYOC CI/CD deployed into your own Cloudflare account. v1 deploys today: it runs heavy GitHub Actions jobs on Cloudflare Workflows and Containers. v2 is specified and partly built: a local-first control plane that runs work on hardware you own first and overflows to Cloudflare Containers and AWS. Runs are typed Effect programs, not YAML.",
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
