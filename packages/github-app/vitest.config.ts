import { defineConfig } from "vitest/config";

// github-app is provider-neutral fetch code — its tests mock api.github.com
// with MSW and run under plain Node + Vitest 2 (no Workers pool, which would
// require Vitest 3). `crypto.subtle` is available natively on the Node global.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
