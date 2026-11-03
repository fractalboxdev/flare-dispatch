// A fresh D1 database on workerd through Miniflare, with host-cloudflare's tables and FlareDispatch's own, so each
// test reads and writes the tables the Worker does.
import { runD1Migrations, type D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
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

/** An alarm port that records each delivered alarm. */
export const recordingAlarms = () => {
  const delivered: Alarm[] = [];
  const layer = Layer.succeed(AlarmPort, {
    deliver: (alarm) => Effect.sync(() => void delivered.push(alarm)),
  });
  return { delivered, layer };
};
