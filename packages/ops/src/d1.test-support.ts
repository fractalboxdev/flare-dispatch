// A fresh D1 database with host-cloudflare's tables and FlareDispatch's own, so each test reads and writes the tables
// the Worker does: on workerd through Miniflare, or in process over Node's SQLite for a suite that needs only SQL and
// must not start a workerd process per test.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  runD1Migrations,
  type D1Like,
  type D1Statement,
} from "@fractalboxdev/mameko-host-cloudflare/d1";
import { AlarmPort, type Alarm } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { Miniflare } from "miniflare";
import { runOpsMigrations } from "./liveness.ts";

export interface TestDb {
  readonly db: D1Like;
  readonly dispose: () => Promise<void>;
}

export const freshDb = async (): Promise<TestDb> => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('') } }",
    compatibilityDate: "2026-05-01",
    d1Databases: { DB: crypto.randomUUID() },
  });
  const db = (await mf.getD1Database("DB")) as unknown as D1Like;
  await runD1Migrations(db);
  await runOpsMigrations(db);
  return { db, dispose: () => mf.dispose() };
};

const statement = (
  db: DatabaseSync,
  sql: string,
  params: readonly unknown[] = [],
): D1Statement => ({
  bind: (...values) => statement(db, sql, values),
  run: async () => db.prepare(sql).run(...(params as SQLInputValue[])),
  all: async () => ({ results: db.prepare(sql).all(...(params as SQLInputValue[])) as unknown[] }),
});

/** The same tables in an in-memory SQLite database; `batch` runs in one transaction, as D1 runs it atomically. */
export const sqliteDb = async (): Promise<TestDb> => {
  const sqlite = new DatabaseSync(":memory:");
  const db: D1Like = {
    prepare: (sql) => statement(sqlite, sql),
    batch: async (statements) => {
      sqlite.exec("begin");
      try {
        const out = [];
        for (const s of statements) out.push(await s.all());
        sqlite.exec("commit");
        return out;
      } catch (e) {
        sqlite.exec("rollback");
        throw e;
      }
    },
  };
  await runD1Migrations(db);
  await runOpsMigrations(db);
  return { db, dispose: async () => sqlite.close() };
};

/** An alarm port that records each delivered alarm. */
export const recordingAlarms = () => {
  const delivered: Alarm[] = [];
  const layer = Layer.succeed(AlarmPort, {
    deliver: (alarm) => Effect.sync(() => void delivered.push(alarm)),
  });
  return { delivered, layer };
};
