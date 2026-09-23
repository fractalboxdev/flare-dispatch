import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { pageFrontmatter, pageId } from "./lib/pages.mjs";

// The docs collection is Starlight's glob over src/content/docs/, whose entries are
// relative symbolic links into the repository. Repository Markdown carries no front
// matter: its title comes from the first `# heading` and its description from the
// first paragraph, and README.md becomes the index of its directory.
const loader = docsLoader({ generateId: pageId });

const docs = defineCollection({
  loader: {
    name: "flare-dispatch-docs-loader",
    load: (context) =>
      loader.load({
        ...context,
        parseData: (props) => context.parseData({ ...props, data: pageFrontmatter(props.data, props.filePath) }),
      }),
  },
  schema: docsSchema(),
});

export const collections = { docs };
