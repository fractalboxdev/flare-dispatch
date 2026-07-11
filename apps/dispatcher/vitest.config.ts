import { defineConfig } from "vitest/config";

// Dispatcher route tests run under plain Node + Vitest 2 — NOT
// `@cloudflare/vitest-pool-workers` (that needs Vitest 3; the repo is pinned to
// Vitest 2). The router and route modules import nothing from the Cloudflare
// runtime, and HMAC verify is pure WebCrypto (`globalThis.crypto`, on Node 20+),
// so the default Node environment is sufficient.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
