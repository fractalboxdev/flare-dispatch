// The e2e-local device path (specs/verification.md § V-E2E-LOCAL): the suites under `test/e2e-local/device/`, each
// over the control plane under `wrangler dev`, the key helper and the device executor built from `vendor/mameko`,
// one file at a time so the stacks do not compete for the machine.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "control-plane-e2e-local-device",
    include: ["test/e2e-local/device/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 180_000,
    // The first run builds the device programs.
    hookTimeout: 900_000,
  },
});
