// The stores the live `WritebackRecords` reads, in memory: mameko's tables over `node:sqlite` and an R2-like bucket.
import { DatabaseSync } from "node:sqlite";
import type { D1Binding } from "../local/store.ts";
import type { ArtifactObjects } from "./records.ts";

/** mameko's `placements`, `executors` and `model_calls` columns the records read, over `node:sqlite`. */
export const recordsDb = (): D1Binding & { readonly exec: (sql: string) => void } => {
  const db = new DatabaseSync(":memory:");
  db.exec(`create table placements (execution_id text primary key, state text not null, epoch integer not null,
    executor_id text, accepted_epoch integer)`);
  db.exec("create table executors (executor_id text primary key, kind text not null)");
  db.exec("create table model_calls (call_id text primary key, execution_id text not null)");
  return {
    exec: (sql) => db.exec(sql),
    prepare: (query) => ({
      bind: (...values) => ({
        run: async () => db.prepare(query).run(...(values as (string | number | null)[])),
        all: async () => ({
          results: db.prepare(query).all(...(values as (string | number | null)[])),
        }),
      }),
    }),
  };
};

export const memoryBucket = (): ArtifactObjects & { readonly objects: Map<string, Uint8Array> } => {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    get: async (key) => {
      const bytes = objects.get(key);
      return bytes === undefined
        ? null
        : { arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer };
    },
  };
};

export const artifactPath = (executionId: string, epoch: number, name: string) =>
  `artifacts/${executionId}/${epoch}/${name}`;
