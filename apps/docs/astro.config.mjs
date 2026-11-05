// @ts-check
import { defineConfig } from "astro/config";
import { satteri } from "@astrojs/markdown-satteri";
import starlight from "@astrojs/starlight";
import merlion from "@fractalbox/merlion-astro";
import starlightLinksValidator from "starlight-links-validator";
import { sidebar } from "./src/lib/nav.mjs";
import { README_PAGES, repoLinks } from "./src/lib/pages.mjs";

const DESCRIPTION =
  "Local-first CI/CD in your own Cloudflare account: runs execute on hardware you own first and spill to Cloudflare Containers and AWS, under a spend guard and a fenced lease.";

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
            ["/", "/benchmarks/", "/llms.txt", "/llms-full.txt"].includes(link) ||
            // README.md pages served at their directory (src/lib/pages.mjs).
            README_PAGES.has(link.replace(/#.*$/, "")),
        }),
      ],
      sidebar: sidebar(),
    }),
    // Every ```mermaid block renders to inline, themeable SVG at build time.
    merlion({ stylesheet: "src/styles/diagrams.css", width: 720 }),
  ],
  vite: {
    server: { allowedHosts: [".ts.net"] },
  },
});
