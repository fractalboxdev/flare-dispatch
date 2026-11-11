import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The control plane's tick and composition modules import host-cloudflare's Durable Object classes, whose base
      // class exists only under workerd; the suites that import them in Node instantiate none.
      "cloudflare:workers": join(
        import.meta.dirname,
        "../../apps/control-plane/test/e2e-local/fixtures/cloudflare-workers.ts",
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
