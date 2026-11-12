import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "local-ci",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
