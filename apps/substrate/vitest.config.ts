import { defineConfig } from "vitest/config";

// Substrate default (Node) project. Engine + admission tests run under plain
// Node: the modules under test import nothing from the Cloudflare runtime (the
// split policy.ts documents), and the ticket/approval crypto is pure WebCrypto
// (`globalThis.crypto`, Node 20+).
//
// The `*.workers.test.ts` suites run INSIDE workerd via the Workers pool and
// are owned by `vitest.workers.config.ts` (registered separately in the root
// workspace), so they are excluded here rather than double-run in Node — where
// `cloudflare:test` does not resolve at all.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.workers.test.ts"],
  },
});
