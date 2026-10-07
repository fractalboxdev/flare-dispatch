import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
export default defineWorkersConfig({
  test: {
    name: "check-command-storage",
    include: [
      "src/check-command-storage.workers.test.ts",
      "src/check-command-live.workers.test.ts",
    ],
    poolOptions: {
      workers: {
        main: "./src/check-command-worker-fixture.ts",
        miniflare: {
          compatibilityDate: "2026-05-01",
          compatibilityFlags: ["nodejs_compat"],
          r2Buckets: ["CHECK_COMMAND_LOGS"],
          durableObjects: {
            CHECK_COMMAND_STORAGE: { className: "CheckCommandTestStorage", useSQLite: true },
          },
        },
      },
    },
  },
});
