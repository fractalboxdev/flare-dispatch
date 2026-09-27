import { defineConfig } from "vitest/config";

// The offline MR-review replay (scripts/mr-review.replay.ts) — calls Workers AI
// over REST, so it is NEVER part of `pnpm test`. See the script's header.
export default defineConfig({
  test: {
    include: ["scripts/**/*.replay.ts"],
  },
});
