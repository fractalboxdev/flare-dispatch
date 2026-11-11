import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The composition imports host-cloudflare's Durable Object classes, whose base class exists only under workerd;
      // the suites that build the isolate's services in Node instantiate none.
      "cloudflare:workers": join(
        import.meta.dirname,
        "test/e2e-local/fixtures/cloudflare-workers.ts",
      ),
    },
  },
  test: {
    name: "control-plane",
    include: ["test/**/*.test.ts"],
    // The e2e-local stack runs in its own job (`vitest.e2e.config.ts`), not in `pnpm test`.
    exclude: ["test/e2e-local/**", "**/node_modules/**"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
