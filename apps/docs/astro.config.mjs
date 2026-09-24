// @ts-check
import { defineConfig } from "astro/config";
import { satteri } from "@astrojs/markdown-satteri";
import starlight from "@astrojs/starlight";
import merlion from "@fractalbox/merlion-astro";
import starlightLinksValidator from "starlight-links-validator";
import { README_PAGES, repoLinks } from "./src/lib/pages.mjs";

const DESCRIPTION =
  "FlareDispatch offloads the expensive half of GitHub Actions — agentic review, Playwright e2e, acceptance suites, matrix fan-outs — onto a Cloudflare stack you own.";

export default defineConfig({
  site: "https://flare-dispatch.fractalbox.dev",
  trailingSlash: "always",
  markdown: {
    // Pages are repository Markdown whose relative links point at sibling files, as on
    // GitHub; on the site they point at pages (src/lib/pages.mjs).
    processor: satteri({ hastPlugins: [repoLinks] }),
  },
  integrations: [
    starlight({
      title: "FlareDispatch",
      description: DESCRIPTION,
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/fractalboxdev/flare-dispatch" }],
      lastUpdated: false,
      customCss: ["./src/styles/brand.css"],
      head: [{ tag: "link", attrs: { rel: "alternate", type: "text/plain", href: "/llms.txt", title: "llms.txt" } }],
      plugins: [
        starlightLinksValidator({
          errorOnLocalLinks: true,
          exclude: ({ link }) =>
            // Pages outside the docs collection.
            ["/llms.txt", "/llms-full.txt"].includes(link) ||
            // README.md pages served at their directory (src/lib/pages.mjs).
            README_PAGES.has(link.replace(/#.*$/, "")),
        }),
      ],
      sidebar: [
        { label: "Overview", link: "/" },
        {
          label: "GitHub Actions",
          items: ["actions", "actions/flare-dispatch-action", "actions/deploy-dispatcher-action"],
        },
        { label: "Run catalog", slug: "runs" },
        {
          label: "Substrate",
          items: [
            "substrate",
            "substrate/facade",
            "substrate/grant-profiles",
            "substrate/byoc-upgrade",
            "substrate/contract-versioning",
          ],
        },
        { label: "API reference", items: [{ label: "Substrate facade", slug: "reference/substrate-contract" }] },
        {
          label: "Design records",
          collapsed: true,
          items: [
            { label: "Dispatcher ADRs", collapsed: true, items: [{ autogenerate: { directory: "design/adr" } }] },
            { label: "Dispatcher specs", collapsed: true, items: [{ autogenerate: { directory: "design/dispatcher" } }] },
            { label: "Substrate specs", collapsed: true, items: [{ autogenerate: { directory: "design/substrate" } }] },
          ],
        },
      ],
    }),
    // Every ```mermaid block renders to inline, themeable SVG at build time.
    merlion({ stylesheet: "src/styles/diagrams.css", width: 720 }),
  ],
  vite: {
    server: { allowedHosts: [".ts.net"] },
  },
});
