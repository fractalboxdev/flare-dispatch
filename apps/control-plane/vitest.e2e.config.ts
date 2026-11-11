// The e2e-local job's cloud path (specs/verification.md § V-E2E-LOCAL): every suite under `test/e2e-local/`, each file
// with its own stack, one file at a time so the stacks do not compete for the machine.
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": join(
        import.meta.dirname,
        "test/e2e-local/fixtures/cloudflare-workers.ts",
      ),
    },
  },
  test: {
    name: "control-plane-e2e-local",
    include: ["test/e2e-local/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
