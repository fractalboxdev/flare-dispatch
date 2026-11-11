// A D1 binding over an in-memory `node:sqlite` database, with mameko's store migrations, the local store's and the
// suppression ledger's applied.
import { DatabaseSync } from "node:sqlite";
import { HOST_CLOUDFLARE_MIGRATIONS } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { SUPPRESSION_LEDGER_MIGRATIONS } from "../suppression/ledger.ts";
import { LOCAL_STORE_MIGRATIONS, type D1Binding } from "./store.ts";

export const memoryD1 = (): D1Binding & { readonly fail: { on: boolean } } => {
  const db = new DatabaseSync(":memory:");
  for (const m of [
    ...HOST_CLOUDFLARE_MIGRATIONS,
    ...LOCAL_STORE_MIGRATIONS,
    ...SUPPRESSION_LEDGER_MIGRATIONS,
  ])
    for (const sql of m.sql) db.exec(sql);
  const fail = { on: false };
  const guard = () => {
    if (fail.on) throw new Error("D1_ERROR: injected");
  };
  return {
    fail,
    prepare: (query) => ({
      bind: (...values) => ({
        run: async () => {
          guard();
          return db.prepare(query).run(...(values as (string | number | null)[]));
        },
        all: async () => {
          guard();
          return { results: db.prepare(query).all(...(values as (string | number | null)[])) };
        },
      }),
    }),
  };
};
