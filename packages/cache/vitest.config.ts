import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "cache",
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
