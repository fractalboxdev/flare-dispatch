// A deploy whose artifact store predates the `fd_artifacts` name keeps its rows, and mameko's own `artifacts` table and
// `artifacts_execution` index can then be created (mameko migration 33).
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ARTIFACT_SCHEMA, moveLegacyArtifactsTable } from "./artifacts.ts";

let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(''); } }",
    compatibilityDate: "2026-05-01",
    d1Databases: ["LEGACY", "FRESH"],
  });
}, 60_000);
afterAll(() => mf?.dispose());

/** The store's schema as a deploy before the rename created it: the table and indexes under their old names. */
const legacySchema = ARTIFACT_SCHEMA.map((sql) =>
  sql
    .replace(/\bfd_artifacts_(execution|expiry)\b/g, "artifacts_$1")
    .replace(/\bfd_artifacts\b/g, "artifacts"),
);

describe("the artifact store's table move", () => {
  it("renames a legacy artifacts table with its rows, after which mameko's artifacts table and index create", async () => {
    const db = (await mf.getD1Database("LEGACY")) as unknown as D1Database;
    for (const sql of legacySchema) await db.prepare(sql).run();
    await db
      .prepare(
        `insert into artifacts (artifact_id, execution_id, epoch, name, size, sha256, content_type,
           producer_executor_id, producer_executor_kind, repo, private, r2_path, browse, created_at, expires_at)
         values ('A1', 'E1', 1, 'dist/app.tgz', 5, ?1, 'application/gzip', 'cf-1', 'cloudflare', 'acme/widgets', 1,
           'artifacts/E1/1/dist/app.tgz', 0, 1, 2)`,
      )
      .bind("0".repeat(64))
      .run();
    expect(await moveLegacyArtifactsTable(db)).toBe(true);
    for (const sql of ARTIFACT_SCHEMA) await db.prepare(sql).run();
    expect(
      await db.prepare("select artifact_id, name from fd_artifacts").all<{ artifact_id: string }>(),
    ).toMatchObject({ results: [{ artifact_id: "A1", name: "dist/app.tgz" }] });
    // mameko's migration 33, verbatim in shape: neither its table nor its index name collides now.
    await db
      .prepare(
        `create table artifacts (seq integer primary key autoincrement, execution_id text not null,
           epoch integer not null, name text not null, object_key text not null unique, sha256 text not null,
           length integer not null, accepted_at integer not null)`,
      )
      .run();
    await db.prepare("create index artifacts_execution on artifacts (execution_id, seq)").run();
    // mameko's table is left as it is.
    expect(await moveLegacyArtifactsTable(db)).toBe(false);
  });

  it("leaves a database with no artifacts table alone", async () => {
    const db = (await mf.getD1Database("FRESH")) as unknown as D1Database;
    expect(await moveLegacyArtifactsTable(db)).toBe(false);
  });
});
