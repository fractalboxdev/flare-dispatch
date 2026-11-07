// @ts-check
import { join } from "node:path";
import { defineConfig } from "astro/config";
import { satteri } from "@astrojs/markdown-satteri";
import starlight from "@astrojs/starlight";
import merlion from "@fractalbox/merlion-astro";
import starlightLinksValidator from "starlight-links-validator";
import { MOUNTS, PAGES, REPO, SPECS_DIR, repoLinks, siteSidebar } from "./src/lib/pages.mjs";
import { siteCheck } from "./src/lib/site-check.mjs";

const DESCRIPTION =
  "Run CI, tasks and agents anywhere. Securely. Documentation for what deploys today, and the specifications of FlareDispatch v2.";

export default defineConfig({
  site: "https://flare-dispatch.fractalbox.dev",
  trailingSlash: "always",
  markdown: {
    // Pages are repository Markdown whose relative links point at sibling files, as on
    // GitHub; on the site they point at pages (src/lib/pages.mjs).
    processor: satteri({ hastPlugins: [repoLinks] }),
  },
  integrations: [
    // First, so its report names a broken link in specs/ before the links validator stops the build.
    siteCheck({ pages: PAGES, specsDir: SPECS_DIR }),
    starlight({
      title: "FlareDispatch",
      description: DESCRIPTION,
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/fractalboxdev/flare-dispatch" }],
      lastUpdated: false,
      customCss: ["./src/styles/brand.css"],
      components: { SocialIcons: "./src/components/SocialIcons.astro" },
      head: [{ tag: "link", attrs: { rel: "alternate", type: "text/plain", href: "/llms.txt", title: "llms.txt" } }],
      markdown: { processedDirs: MOUNTS.map(({ dir }) => join(REPO, dir)) },
      plugins: [
        starlightLinksValidator({
          errorOnLocalLinks: true,
          // Pages outside the docs collection.
          exclude: ["/", "/benchmarks/", "/roadmap/", "/llms.txt", "/llms-full.txt"],
        }),
      ],
      sidebar: siteSidebar(),
    }),
    // Every ```mermaid block renders to inline, themeable SVG at build time.
    merlion({ stylesheet: "src/styles/diagrams.css", width: 720 }),
  ],
  vite: {
    server: { allowedHosts: [".ts.net"] },
    preview: { allowedHosts: [".ts.net"] },
  },
});
