import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "intake",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
  },
});
