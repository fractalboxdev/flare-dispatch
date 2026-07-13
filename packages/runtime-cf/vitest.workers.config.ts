import { fileURLToPath } from "node:url";
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

// runtime-cf Workers-pool project — the `*.workers.test.ts` suites run INSIDE
// workerd via `@cloudflare/vitest-pool-workers` (Vitest 3 unblocked the pool;
// the prior Vitest-2 pin forced these onto a Node-side Miniflare harness).
// Pinned to the 0.12.x line, the last that supports Vitest 3.2.x — 0.13+ moved
// to Vitest 4's `poolRunner` API, which would cascade `@effect/vitest` → 4-beta
// → Effect 4-beta across the whole repo.
//
// Registered explicitly in the root `vitest.workspace.ts` alongside the default
// (Node) project, which excludes `*.workers.test.ts`.
//
// Migrations are read here on the Node side (`node:fs` is unavailable in
// workerd) and handed to the runtime via the `TEST_MIGRATIONS` binding;
// `src/apply-migrations.ts` seeds them into each suite's isolated storage.

const migrations = await readD1Migrations(
  fileURLToPath(new URL("../../infra/migrations", import.meta.url)),
);

export default defineWorkersConfig({
  test: {
    name: "runtime-cf-workers",
    include: ["src/**/*.workers.test.ts"],
    setupFiles: ["./src/apply-migrations.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        miniflare: {
          compatibilityDate: "2026-05-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["RUNS_METADATA"],
          r2Buckets: ["RUNS_STORAGE"],
          kvNamespaces: ["CONFIG_KV"],
          bindings: { TEST_MIGRATIONS: migrations },
        },
      },
    },
  },
});
