import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MOUNTS, REPO, pageFrontmatter } from "./lib/pages.mjs";
import { pageId } from "./lib/specs.mjs";

// The docs collection is Astro's glob loader over each mount in src/lib/pages.mjs, read in place.
// Repository Markdown carries no front matter: its title comes from the first `# heading` and its
// description from the first paragraph, and README.md becomes the index of its directory.
const docs = defineCollection({
  loader: {
    name: "flare-dispatch-docs-loader",
    load: async (context) => {
      const read = new Set<string>();
      // A glob loader deletes every store key it did not read, and each mount reads only its own
      // files, so the mounts see no keys and stale entries are deleted once all of them finish.
      const store = { ...context.store, keys: () => [] };
      await Promise.all(
        MOUNTS.map(({ dir, route, files }) =>
          glob({
            base: pathToFileURL(join(REPO, dir)),
            pattern: files ? [...files] : "**/*.md",
            generateId: ({ entry }) => {
              const id = pageId(route, entry);
              read.add(id);
              return id;
            },
          }).load({
            ...context,
            store,
            parseData: (props) =>
              context.parseData({ ...props, data: pageFrontmatter(props.data, props.filePath, props.id) }),
          }),
        ),
      );
      for (const id of context.store.keys()) if (!read.has(id)) context.store.delete(id);
    },
  },
  schema: docsSchema(),
});

export const collections = { docs };
