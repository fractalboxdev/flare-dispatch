import { defineConfig } from "vitest/config";

// runtime-cf default (Node) project. Most integration tests drive real D1 / R2
// via a Miniflare instance booted in test setup (see src/*.test.ts) — plain
// Node + Vitest, no Workers pool. Miniflare is started/stopped per suite, so
// the default forks pool is fine; the only requirement is a generous timeout
// for Miniflare cold-start.
//
// The `*.workers.test.ts` suites run INSIDE workerd via the Workers pool and
// are owned by `vitest.workers.config.ts` (registered separately in the root
// workspace), so they are excluded here to avoid double-running them in Node.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.workers.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
