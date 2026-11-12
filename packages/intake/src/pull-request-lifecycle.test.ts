import { Effect } from "effect";
import { expect, it } from "vitest";
import { d1IntakeStore, IntakeStore, migrateIntake, pullRequestClosedAt } from "./store.ts";
import { sqliteD1 } from "./testing.ts";

it("[FD-CACHE-064] migrates existing close records and never overwrites a newer reopen on repeated migration", async () => {
  const db = sqliteD1();
  try {
    db.sqlite.exec(`create table intake_pull_request_closes (
      repo text not null, number integer not null, closed_at integer not null, primary key (repo, number));
      insert into intake_pull_request_closes values ('acme/app', 12, 1000)`);
    await Effect.runPromise(migrateIntake(db));
    expect(await pullRequestClosedAt(db)("Acme/App", 12)).toBe(1000);
    await Effect.runPromise(
      IntakeStore.use((store) => store.pullRequestReopened("Acme/App", 12, 2000, "reopen")).pipe(
        Effect.provide(d1IntakeStore(db)),
      ),
    );
    await Effect.runPromise(migrateIntake(db));
    expect(await pullRequestClosedAt(db)("acme/app", 12)).toBeNull();
  } finally {
    db.sqlite.close();
  }
});
