// The statement retention the operator overlay sets (specs/provenance.md FD-PROV-075, specs/operability.md
// `provenance.statementRetentionDays`): the committed template renders it into the control plane's vars, and the
// log-append drain's subject retention keeps a logged statement's artifacts for that many days.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SubjectRetention } from "@fractalboxdev/flare-dispatch-cache";
import { migrateIntake } from "@fractalboxdev/flare-dispatch-intake";
import { parseJsonc, placeholderOverlay, renderTemplate } from "@fractalboxdev/flare-dispatch-ops";
import { runD1Migrations } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect } from "effect";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateCache } from "../src/cache-retention.ts";
import { statementRetentionDaysOf, type ControlPlaneEnv } from "../src/config.ts";
import { logAppendLayer } from "../src/provenance.ts";

const DAY = 24 * 3_600_000;
const EXECUTION = "01JDZ8Q6V3M2K9T4WXYZ5ABCDE";

let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(''); } }",
    compatibilityDate: "2026-05-01",
    d1Databases: ["DB0", "DB1"],
  });
}, 60_000);
afterAll(() => mf?.dispose());

const template = readFileSync(join(import.meta.dirname, "../wrangler.jsonc"), "utf8");
const varsOf = async (overlay: typeof placeholderOverlay) =>
  parseJsonc(await Effect.runPromise(renderTemplate("control-plane", template, overlay)))[
    "vars"
  ] as Record<string, unknown>;

describe("the statement retention the overlay sets", () => {
  it("[FD-PROV-075] the committed template renders the statement retention in days, 400 where the overlay sets none", async () => {
    const defaults = await varsOf({ ...placeholderOverlay, provenance: {} });
    expect(defaults["STATEMENT_RETENTION_DAYS"]).toBe(400);
    expect(statementRetentionDaysOf(defaults)).toBe(400);
    const set = await varsOf({ ...placeholderOverlay, provenance: { statementRetentionDays: 730 } });
    expect(set["STATEMENT_RETENTION_DAYS"]).toBe(730);
    expect(statementRetentionDaysOf(set)).toBe(730);
    // A `.dev.vars` entry arrives as text; an unset, empty or malformed var keeps the default.
    expect(statementRetentionDaysOf({ STATEMENT_RETENTION_DAYS: "90" })).toBe(90);
    for (const unset of [undefined, "", "ten", -1, 0, 1.5, {}])
      expect(statementRetentionDaysOf({ STATEMENT_RETENTION_DAYS: unset })).toBe(400);
  });

  it("[FD-PROV-075] the log-append drain keeps a logged statement's artifact for the overlay's statement retention", async () => {
    const retainedFor = async (database: string, overlay: typeof placeholderOverlay) => {
      const db = (await mf.getD1Database(database)) as unknown as D1Database;
      await runD1Migrations(db as never);
      await Effect.runPromise(migrateIntake(db as never));
      await migrateCache(db as never);
      const created = Date.now();
      await db
        .prepare(
          `insert into artifacts (artifact_id, execution_id, epoch, name, size, sha256, content_type,
             producer_executor_id, producer_executor_kind, repo, private, r2_path, browse, created_at, expires_at)
           values ('A1', ?1, 1, 'dist/app.tgz', 5, ?2, 'application/gzip', 'cf-1', 'cloudflare', 'acme/widgets', 1,
             'artifacts/x/1/dist/app.tgz', 0, ?3, ?4)`,
        )
        .bind(EXECUTION, "0".repeat(64), created, created + 30 * DAY)
        .run();
      const env = {
        PLANE_ID: "flare-dispatch",
        DB: db,
        ...(await varsOf(overlay)),
      } as unknown as ControlPlaneEnv;
      const integratedTime = created + 60_000;
      await Effect.runPromise(
        SubjectRetention.use((r) =>
          r.retain({ executionId: EXECUTION, epoch: 1, names: ["dist/app.tgz"], integratedTime }),
        ).pipe(Effect.provide(logAppendLayer(env))),
      );
      const row = await db
        .prepare("select expires_at from artifacts where artifact_id = 'A1'")
        .first<{ expires_at: number }>();
      return (row!.expires_at - integratedTime) / DAY;
    };
    expect(
      await retainedFor("DB0", {
        ...placeholderOverlay,
        provenance: { statementRetentionDays: 730 },
      }),
    ).toBe(730);
    expect(await retainedFor("DB1", { ...placeholderOverlay, provenance: {} })).toBe(400);
  });
});
