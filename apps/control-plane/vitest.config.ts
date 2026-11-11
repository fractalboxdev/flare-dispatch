import { defineConfig } from "vitest/config";

export default defineConfig({
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
