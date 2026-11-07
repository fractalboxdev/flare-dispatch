import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "control-plane",
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
