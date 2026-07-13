// Ambient types for the `@cloudflare/vitest-pool-workers` test bindings.
//
// Augments the `cloudflare:test` virtual module's `ProvidedEnv` with exactly
// the D1 / R2 / KV bindings + the `TEST_MIGRATIONS` hand-off the workers config
// wires in, so `env` is typed in the in-workerd suites (`*.workers.test.ts` +
// `apply-migrations.ts`). The base `cloudflare:test` module declaration ships
// with the pool package (its `.` types entry).

import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    RUNS_METADATA: D1Database;
    RUNS_STORAGE: R2Bucket;
    CONFIG_KV: KVNamespace;
    TEST_MIGRATIONS: D1Migration[];
  }
}
