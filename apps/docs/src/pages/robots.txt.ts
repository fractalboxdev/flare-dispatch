// /robots.txt: every crawler, AI search and training crawlers included, may read the
// whole site; the sitemap comes from Starlight's @astrojs/sitemap.
import type { APIRoute } from "astro";
import { SITE } from "../lib/llms";

const AI_CRAWLERS = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "Applebot-Extended", "CCBot"];

export const GET: APIRoute = ({ site }) => {
  const body = [
    "User-agent: *",
    "Allow: /",
    "",
    ...AI_CRAWLERS.flatMap((ua) => [`User-agent: ${ua}`, "Allow: /", ""]),
    `Sitemap: ${new URL("/sitemap-index.xml", site ?? SITE).href}`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
