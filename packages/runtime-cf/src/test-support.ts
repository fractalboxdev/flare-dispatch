// @fractalboxdev/flare-dispatch-runtime-cf — integration-test support.
//
// The integration tests exercise the live D1 / R2 Layers against real bindings.
// This is the Node-side Miniflare harness: the test body runs in Node and
// drives a Miniflare instance from the outside. The D1 state machines
// (admission / leasing / executions) have since moved to `*.workers.test.ts`,
// which run INSIDE workerd via `@cloudflare/vitest-pool-workers` against
// `test-support-workers.ts` (unblocked by the Vitest 3 upgrade). The remaining
// suites — R2 / KV and the msw-backed GitHub paths, which the Workers pool
// can't host directly — stay on this helper. `makeTestBindings` spins up
// Miniflare with D1 + R2 + KV bindings, applies every migration under
// infra/migrations/ in order, and hands back the live `D1Database` /
// `R2Bucket` / `KVNamespace` objects.
//
// Spec: specs/pm/plan.md § PR4 acceptance.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

/** A booted Miniflare instance plus its D1 / R2 / KV bindings. */
export type TestBindings = {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly kv: KVNamespace;
  /** Tear the Miniflare instance down — call in `afterAll`/`afterEach`. */
  readonly dispose: () => Promise<void>;
};

/**
 * The D1 schema, read once — every migration under infra/migrations/,
 * concatenated in filename order. Tests apply EXACTLY what
 * `wrangler d1 migrations apply` runs in production, so the two can never
 * drift (the old single d1-schema.sql had no applied-state tracking and is
 * gone).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../infra/migrations/", import.meta.url));
const D1_SCHEMA = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(new URL(f, `file://${MIGRATIONS_DIR}`), "utf8"))
  .join("\n");

/**
 * Boot a Miniflare instance with a D1 database + R2 bucket + KV namespace,
 * apply every D1 migration in order, and return the live bindings. The worker script is a
 * no-op `fetch` handler — the tests drive the bindings directly, never the
 * Worker.
 */
export const makeTestBindings = async (): Promise<TestBindings> => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    compatibilityDate: "2026-05-01",
    d1Databases: { RUNS_METADATA: ":memory:" },
    r2Buckets: { RUNS_STORAGE: "runs-storage" },
    kvNamespaces: { CONFIG_KV: "config-kv" },
  });

  const db = (await mf.getD1Database("RUNS_METADATA")) as unknown as D1Database;
  const bucket = (await mf.getR2Bucket("RUNS_STORAGE")) as unknown as R2Bucket;
  const kv = (await mf.getKVNamespace("CONFIG_KV")) as unknown as KVNamespace;

  // Apply the migrations. D1's `exec` runs one statement per line, so the
  // multi-line `CREATE TABLE`s are collapsed to single lines. Comments are
  // stripped BEFORE splitting on ";" — splitting first turned a semicolon
  // inside a comment into a corrupted next statement.
  const statements = D1_SCHEMA.split("\n")
    .map((line) => line.replace(/--.*$/, "").trim())
    .filter(Boolean)
    .join(" ")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.exec(statement);
  }

  return { db, bucket, kv, dispose: () => mf.dispose() };
};

/** Count rows in a table — the D1-write-rate assertion helper (plan § 6). */
export const countRows = async (db: D1Database, table: string): Promise<number> => {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
};
