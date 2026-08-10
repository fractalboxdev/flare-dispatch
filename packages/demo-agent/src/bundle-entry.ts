#!/usr/bin/env node
// @fractalboxdev/flare-dispatch-demo-agent — bundle entry point.
//
// `src/main.ts` is the local-dev `bin` target carrying a `tsx` shebang so
// `pnpm demo-agent <cmd>` runs through `tsx` without an explicit build step.
// This file is the entry for the production bundle (`pnpm build` →
// `dist/demo-agent.cjs`). The `#!/usr/bin/env node` shebang above is THE
// shebang on the baked binary: Rolldown preserves an ENTRY-file hashbang to
// line 1 of the bundle (exactly as flare-agent's `src/main.ts` does), so the
// container's COPY-to-/usr/local/bin/demo-agent + `chmod +x` yields a binary
// that executes under node — not `/bin/sh`. Without it the kernel falls back
// to `/bin/sh`, which chokes on the JS on line 1 (the #185 esbuild→tsdown
// switch dropped the old `--banner:js=…node…`, freezing the image build).

// Side-effect import — main.ts's top level runs the CLI when the bundle is
// loaded. `import "./main.js"` (not `export *`) guarantees evaluation under
// any module system Rolldown picks.
import "./main.js";
