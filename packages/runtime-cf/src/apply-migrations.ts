// Workers-pool test setup — seed the D1 schema before each `*.workers.test.ts`
// runs inside workerd.
//
// `node:fs` is unavailable in the Workers runtime, so the migrations can't be
// read here the way the Miniflare helper does. Instead `vitest.workers.config.ts`
// reads them on the Node side (`readD1Migrations`) and hands them in via the
// `TEST_MIGRATIONS` binding; `applyD1Migrations` applies the un-applied ones to
// the live `RUNS_METADATA` D1 binding. Run as a `setupFiles` entry, this seeds
// the schema into the pool's isolated-storage baseline, so every test in the
// file starts from the exact production migration state with empty tables.

import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.RUNS_METADATA, env.TEST_MIGRATIONS);
