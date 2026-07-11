// @fractalbox/flare-dispatch-runtime-cf — integration-test support, Workers-pool variant.
//
// The sibling `test-support.ts` boots Miniflare from Node and drives its
// bindings from the outside; this variant is for suites that run *inside* the
// Workers runtime via `@cloudflare/vitest-pool-workers` (Vitest 3 unblocked the
// pool — see the PR that removed the Vitest-2 pin). Here the test body itself
// executes in workerd, so it reads the live D1 / R2 / KV bindings straight off
// `cloudflare:test`'s `env` — the same objects production code sees — instead
// of a Node-side handle.
//
// The D1 schema is seeded once per test file by `apply-migrations.ts`
// (a `setupFiles` entry), and the pool's per-test isolated storage resets row
// state between tests — so `makeTestBindings` is just a typed accessor and
// `dispose` is a no-op, keeping the call shape identical to the Miniflare
// helper (`beforeEach` acquire / `afterEach` dispose).

import { env } from "cloudflare:test";

/** The live D1 / R2 / KV bindings, plus a no-op `dispose` for call-shape parity. */
export type TestBindings = {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly kv: KVNamespace;
  /** No-op — the pool's isolated storage tears down per-test state. */
  readonly dispose: () => Promise<void>;
};

/** Return the live, migration-seeded bindings for the current isolated test. */
export const makeTestBindings = async (): Promise<TestBindings> => ({
  db: env.RUNS_METADATA,
  bucket: env.RUNS_STORAGE,
  kv: env.CONFIG_KV,
  dispose: async () => {},
});

/** Count rows in a table — the D1-write-rate assertion helper (plan § 6). */
export const countRows = async (
  db: D1Database,
  table: string,
): Promise<number> => {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .first<{ n: number }>();
  return row?.n ?? 0;
};
