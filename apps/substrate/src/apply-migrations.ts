// Workers-pool test setup — seed the admission D1 schema before each
// `*.workers.test.ts` runs inside workerd.
//
// `node:fs` is unavailable in the Workers runtime, so `vitest.workers.config.ts`
// reads `migrations/` on the Node side (`readD1Migrations`) and hands them in
// through the `TEST_MIGRATIONS` binding. Applying them here, as a `setupFiles`
// entry, folds the schema into the pool's isolated-storage baseline: every test
// starts from the exact production migration state with empty tables.
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.ADMISSION_DB, env.TEST_MIGRATIONS);
