import { defineConfig } from "vitest/config";

// Engine + admission tests run under plain Node: the modules under test import
// nothing from the Cloudflare runtime (the split policy.ts documents), and the
// ticket/approval crypto is pure WebCrypto (`globalThis.crypto`, Node 20+).
// The DO and facade classes are exercised behind structural fakes; workerd
// coverage arrives with the vitest-pool-workers project at dispatcher adoption.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
