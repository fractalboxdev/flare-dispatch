import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "dogfood",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
