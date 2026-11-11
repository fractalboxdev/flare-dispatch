import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { runD1Migrations, type D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { OTHER_CACHE_TRIGGER } from "./event.ts";
import { testRun } from "./harness.test-support.ts";
import { d1IntakeStore, IntakeStore, migrateIntake, type IntakeRecord } from "./store.ts";
import { dataClassesOf, submission } from "./submit.ts";
import { sqliteD1 } from "./testing.ts";

// The schema deployed before data classes were recorded. Keep this fixture independent of the current CREATE.
const LEGACY_TABLE = `create table intake_records (
  execution_id text primary key, trigger text not null, run text not null, label text,
  repo text not null, sha text not null, ref text not null, inputs_json text not null,
  class text not null, labels_json text not null, attempt integer not null, family_root text not null,
  installation integer, caller text, not_before integer, spend_line text, placement_constraint text,
  cache_trigger_json text, eligible_kinds text, created_at integer not null)`;

const legacyDb = async () => {
  const db = sqliteD1();
  await runD1Migrations(db);
  db.sqlite.exec(LEGACY_TABLE);
  db.sqlite.exec(`insert into intake_records
    (execution_id, trigger, run, repo, sha, ref, inputs_json, class, labels_json, attempt, family_root,
      caller, created_at)
    values ('legacy', 'webhook', 'review', 'acme/private', '${"a".repeat(40)}', 'refs/heads/main',
      '{"text":"keep this input"}', 'interactive', '[]', 1, 'legacy', 'member@acme.test', 10)`);
  return db;
};

const record = (id: string, associations: readonly string[] = ["MEMBER"]): IntakeRecord => ({
  executionId: id,
  trigger: "dispatch",
  run: "review",
  label: null,
  repo: "acme/public",
  sha: "b".repeat(40),
  ref: "refs/heads/main",
  inputs: { text: id },
  className: "interactive",
  labels: [],
  attempt: 1,
  familyRoot: id,
  installation: 7,
  caller: "operator@acme.test",
  notBefore: null,
  spendLine: null,
  placementConstraint: null,
  cacheTrigger: OTHER_CACHE_TRIGGER,
  eligibleKinds: null,
  repositoryPublic: true,
  inputAssociations: associations,
  createdAt: 20,
});

const get = (db: D1Like, id: string) =>
  Effect.runPromise(IntakeStore.use((s) => s.get(id)).pipe(Effect.provide(d1IntakeStore(db))));
const put = (db: D1Like, row: IntakeRecord) =>
  Effect.runPromise(IntakeStore.use((s) => s.put(row)).pipe(Effect.provide(d1IntakeStore(db))));

describe("intake data-class schema upgrades", () => {
  it("[FD-AGT-005] upgrades an existing table, preserves its inputs and caller, and gives a legacy attempt no inferred trust", async () => {
    const db = await legacyDb();
    await Effect.runPromise(migrateIntake(db));
    await Effect.runPromise(migrateIntake(db));
    const legacy = (await get(db, "legacy"))!;
    expect(legacy).toMatchObject({
      inputs: { text: "keep this input" },
      caller: "member@acme.test",
      repositoryPublic: null,
      inputAssociations: ["NONE"],
    });
    expect(
      db.sqlite
        .prepare("select input_associations_json from intake_records where execution_id = 'legacy'")
        .get(),
    ).toMatchObject({ input_associations_json: '["NONE"]' });
    const request = submission({
      ...legacy,
      caller: legacy.caller === null ? null : { kind: "access", id: legacy.caller },
      run: testRun("review", { grants: { setup: [], agent: ["cf-api"] } }),
    });
    expect(dataClassesOf(buildProfile("production"), request, "unclassified")).toEqual({
      privateData: true,
      untrustedInput: true,
      outbound: true,
    });
    await put(db, record("after-upgrade"));
    expect(await get(db, "after-upgrade")).toMatchObject({
      repositoryPublic: true,
      inputAssociations: ["MEMBER"],
    });
  });

  it("[FD-AGT-005] fresh migrations and repeated upgrades preserve explicitly recorded visibility and associations", async () => {
    const db = sqliteD1();
    await runD1Migrations(db);
    await Effect.runPromise(migrateIntake(db));
    await put(db, record("trusted"));
    await put(db, record("no-text", []));
    await Effect.runPromise(migrateIntake(db));
    expect(await get(db, "trusted")).toMatchObject({
      repositoryPublic: true,
      inputAssociations: ["MEMBER"],
    });
    expect(await get(db, "no-text")).toMatchObject({
      repositoryPublic: true,
      inputAssociations: [],
    });
  });

  it("fails a storage error during ALTER and can retry the upgrade without losing the legacy row", async () => {
    const db = await legacyDb();
    const broken: D1Like = {
      ...db,
      prepare: (sql) =>
        sql.startsWith("alter table intake_records")
          ? {
              ...db.prepare(sql),
              run: async () => {
                throw new Error("injected storage failure");
              },
            }
          : db.prepare(sql),
    };
    const exit = await Effect.runPromiseExit(migrateIntake(broken));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("injected storage failure");
    expect(db.sqlite.prepare("select count(*) as n from intake_records").get()).toMatchObject({
      n: 1,
    });
    await Effect.runPromise(migrateIntake(db));
    expect(await get(db, "legacy")).toMatchObject({ inputAssociations: ["NONE"] });
  });
});
