import { defineConfig } from "tsdown";

// demo-agent — bundle the AI-driven demo CLI into a single self-contained CJS
// binary baked into the demo container image (Dockerfile.sandbox COPYs
// dist/demo-agent.cjs onto PATH and smoke-tests `demo-agent --help`).
//
// tsdown (Rolldown + Oxc) replaces the hand-rolled esbuild invocation. The
// binary runs in a container with NO `node_modules`, so every dependency
// (effect, @effect/*, puppeteer-core, pngjs, gifenc, the workspace
// bedrock-sigv4) must be inlined — `deps.alwaysBundle` overrides tsdown's
// library default of externalizing dependencies. The entry is a pure
// side-effect CLI (no exports), so `treeshake: false` keeps its top-level run
// from being dropped; `src/bundle-entry.ts` carries the `#!/usr/bin/env node`
// shebang Rolldown preserves to line 1 of the bundle.
export default defineConfig({
  entry: { "demo-agent": "src/bundle-entry.ts" },
  format: "cjs",
  platform: "node",
  target: "node20",
  outDir: "dist",
  deps: { alwaysBundle: [/./] },
  treeshake: false,
  dts: false,
  // ONE self-contained file — the Dockerfile COPYs only `demo-agent.cjs` onto
  // PATH. `codeSplitting: false` collapses STATIC shared chunks, but it does
  // NOT inline DYNAMIC `import()`s (puppeteer-core lazy-loads its BiDi module)
  // nor the Rolldown CJS runtime chunk — under #185 those still emitted as
  // sibling `*.cjs` the container never copied, so the single binary `require`d
  // files that weren't there (image build froze on `demo-agent --help`).
  // `inlineDynamicImports` forces everything into the one entry file.
  codeSplitting: false,
  outputOptions: { inlineDynamicImports: true },
});
