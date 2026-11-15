// The esbuild options and Miniflare modules of a Worker bundle as `wrangler deploy` builds it: the `workerd` export
// condition, so mameko-egress resolves its Workers entry, and each `.wasm` import kept as a module import that Miniflare
// serves as a `CompiledWasm` module beside the script.
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { BuildOptions } from "esbuild";

const wasm = new Map<string, string>();

export const workerdBuild: Pick<BuildOptions, "conditions" | "plugins"> = {
  conditions: ["workerd", "worker", "browser"],
  plugins: [
    {
      name: "workerd-wasm",
      setup(b) {
        b.onResolve({ filter: /\.wasm$/ }, (args) => {
          const path = resolve(args.resolveDir, args.path);
          wasm.set(basename(path), path);
          return { path: `./${basename(path)}`, external: true };
        });
      },
    },
  ],
};

/** The `CompiledWasm` modules the bundles built so far import, by the name each import names. */
export const wasmModules = () =>
  [...wasm].map(([name, path]) => ({
    type: "CompiledWasm" as const,
    path: name,
    contents: readFileSync(path),
  }));
