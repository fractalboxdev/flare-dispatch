// Test support: a D1 over Node's SQLite with mameko's and intake's migrations,
// so admission's real transaction runs under every intake test, and the
// in-memory ports intake calls.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Resolution } from "@fractalboxdev/mameko-coordinator";
import {
  runD1Migrations,
  type D1Like,
  type D1Statement,
} from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect, Layer } from "effect";
import { ClassResolver, type ClassRequest } from "./config.ts";
import { HeldCheckReporter, type HeldCheck } from "./ports.ts";
import { migrateIntake } from "./store.ts";

const statement = (
  db: DatabaseSync,
  count: () => void,
  sql: string,
  params: readonly unknown[] = [],
): D1Statement => ({
  bind: (...values) => statement(db, count, sql, values),
  run: async () => (count(), db.prepare(sql).run(...(params as SQLInputValue[]))),
  all: async () => (
    count(),
    { results: db.prepare(sql).all(...(params as SQLInputValue[])) as unknown[] }
  ),
});

/**
 * A D1 whose `batch` runs in one SQLite transaction, as D1 runs it atomically. `queries` counts every statement it
 * ran, each statement of a batch included, as D1 counts a Worker invocation's queries.
 */
export const sqliteD1 = (): D1Like & { readonly sqlite: DatabaseSync; queries(): number } => {
  const db = new DatabaseSync(":memory:");
  let queries = 0;
  const count = () => void queries++;
  return {
    sqlite: db,
    queries: () => queries,
    prepare: (sql) => statement(db, count, sql),
    batch: async (statements) => {
      db.exec("begin");
      try {
        const out = [];
        for (const s of statements) out.push(await s.all());
        db.exec("commit");
        return out;
      } catch (e) {
        db.exec("rollback");
        throw e;
      }
    },
  };
};

/** A fresh D1 with mameko's tables and intake's. */
export const migratedD1 = async () => {
  const db = sqliteD1();
  await runD1Migrations(db);
  await Effect.runPromise(migrateIntake(db));
  return db;
};

/** A class resolver that answers the run's default class, or what `answer` returns, and records every request. */
export const recordingResolver = (
  seen: ClassRequest[] = [],
  answer: (r: ClassRequest) => Resolution = (r) => ({
    _tag: "Class",
    class: r.run.defaultClass,
    labels: r.trigger === "fork-pr" ? ["untrusted-input"] : [],
    alarm: null,
  }),
) =>
  Layer.succeed(ClassResolver, {
    resolve: (r) =>
      Effect.sync(() => {
        seen.push(r);
        return answer(r);
      }),
  });

/** A held-check reporter that records every queued and dropped check run, in order (FD-INT-057). */
export const recordingHeldChecks = (
  seen: { readonly write: "queued" | "dropped"; readonly check: HeldCheck }[] = [],
) =>
  Layer.succeed(HeldCheckReporter, {
    queued: (check) => Effect.sync(() => void seen.push({ write: "queued", check })),
    dropped: (check) => Effect.sync(() => void seen.push({ write: "dropped", check })),
  });
