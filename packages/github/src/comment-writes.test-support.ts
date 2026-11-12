import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { D1Like, D1Statement } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { d1CommentWrites, type CommentWriteStore } from "./comment-writes.ts";

export const commentDatabase = (): D1Like => {
  const db = new DatabaseSync(":memory:");
  const statement = (sql: string, values: readonly unknown[] = []): D1Statement => ({
    bind: (...values) => statement(sql, values),
    run: async () => db.prepare(sql).run(...(values as SQLInputValue[])),
    all: async () => ({ results: db.prepare(sql).all(...(values as SQLInputValue[])) }),
  });
  return {
    prepare: statement,
    batch: async (statements) => Promise.all(statements.map((s) => s.all())),
  };
};
const stores = new WeakMap<object, CommentWriteStore>();
/** Separate applier instances in a fixture share durable SQL ownership, just as restarted isolates do. */
export const testCommentWrites = (owner: object): CommentWriteStore => {
  const existing = stores.get(owner);
  if (existing !== undefined) return existing;
  const store = d1CommentWrites(commentDatabase());
  stores.set(owner, store);
  return store;
};
