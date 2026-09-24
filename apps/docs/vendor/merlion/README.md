# Merlion packages

The docs site renders every ```` ```mermaid ```` block to inline, themeable SVG at build time through Merlion (`@fractalbox/merlion-astro`, wired in `../../astro.config.mjs`, themed by `../../src/styles/diagrams.css`). The packages are not on npm, so this directory holds their `pnpm pack` tarballs, and `../../package.json` installs them with `file:` specifiers.

| Tarball | Contents |
|---|---|
| `fractalbox-merlion-astro-0.1.0.tgz` | Astro integration |
| `fractalbox-merlion-rehype-0.1.0.tgz` | Markdown plugin that renders the blocks |
| `fractalbox-merlion-wasm-0.1.0.tgz` | Renderer as WebAssembly (`merlion.wasm`, SHA-256 `39dcf5919388f9932bf21fd4c32487c6468b189b5f5cc03a61ba789e37bb40e1`) |
| `fractalbox-merlion-themes-0.1.0.tgz` | Light and dark theme CSS, Inter subset |
| `fractalbox-merlion-view-0.1.0.tgz` | `<merlion-view>` pan and zoom element |

Packed from merlion commit `8950ca08dd0a6a82b270b1506f83e6d0f762d4ed`. To update, in a merlion checkout at the new commit:

```sh
sh packages/merlion-wasm/scripts/build-wasm.sh
for p in astro rehype view themes wasm; do
  (cd packages/merlion-$p && pnpm pack --pack-destination <this directory>)
done
```

then record the commit and the `merlion.wasmSha256` from `packages/merlion-wasm/package.json` here and run `pnpm install` at the repository root.
