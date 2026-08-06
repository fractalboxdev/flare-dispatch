import { describe, expect, it } from "vitest";
import { isProbeFresh, makeProbeStoreD1, PROBE_REVERIFY_MS, type ProbeRecord } from "./store-d1";

const record = (over: Partial<ProbeRecord> = {}): ProbeRecord => ({
  deploymentId: "dep-1",
  probe: "canary",
  status: "passed",
  evidence: "http://example.com/ → HTTP 520",
  substrateVersion: "0.1.0",
  checkedAt: 1_000,
  ...over,
});

describe("isProbeFresh", () => {
  it("stands until the re-verify window closes", () => {
    const at = record().checkedAt;
    expect(isProbeFresh(record(), at + PROBE_REVERIFY_MS.passed - 1)).toBe(true);
    expect(isProbeFresh(record(), at + PROBE_REVERIFY_MS.passed)).toBe(false);
  });

  it("expires an inconclusive verdict far sooner than a decided one", () => {
    // Inconclusive is the only status a transient can cause, so a deployment
    // must not stay unverifiable for a day because one boot timed out.
    expect(PROBE_REVERIFY_MS.inconclusive).toBeLessThan(PROBE_REVERIFY_MS.passed);
    expect(
      isProbeFresh(record({ status: "inconclusive" }), 1_000 + PROBE_REVERIFY_MS.inconclusive),
    ).toBe(false);
  });

  it("treats no record as not fresh", () => {
    expect(isProbeFresh(undefined, Date.now())).toBe(false);
  });
});

type Statement = { sql: string; args: unknown[] };

/** Enough D1 to observe the SQL and the binding order. */
function fakeDb(row?: Record<string, unknown>): { db: D1Database; statements: Statement[] } {
  const statements: Statement[] = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind(...args: unknown[]) {
          statements.push({ sql, args });
          return stmt;
        },
        async first() {
          return row ?? null;
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, statements };
}

describe("makeProbeStoreD1", () => {
  it("reads a row back as a record", async () => {
    const { db, statements } = fakeDb({
      deployment_id: "dep-1",
      probe: "canary",
      status: "passed",
      evidence: "ok",
      substrate_version: "0.1.0",
      checked_at: 42,
    });
    expect(await makeProbeStoreD1(db).read("dep-1", "canary")).toEqual(
      record({ evidence: "ok", checkedAt: 42 }),
    );
    expect(statements[0]?.args).toEqual(["dep-1", "canary"]);
  });

  it("ignores a status this build does not know", async () => {
    // A row written by a newer substrate must never be read as a pass by an
    // older one — an unknown status is no record at all, which fails closed.
    const { db } = fakeDb({
      deployment_id: "dep-1",
      probe: "canary",
      status: "quarantined",
      evidence: "",
      substrate_version: "9.9.9",
      checked_at: 42,
    });
    expect(await makeProbeStoreD1(db).read("dep-1", "canary")).toBeUndefined();
  });

  it("upserts on (deployment, probe) so a re-probe replaces its predecessor", async () => {
    const { db, statements } = fakeDb();
    await makeProbeStoreD1(db).record(record({ status: "failed", evidence: "reached" }));
    expect(statements[0]?.sql).toContain("ON CONFLICT (deployment_id, probe) DO UPDATE");
    expect(statements[0]?.args).toEqual(["dep-1", "canary", "failed", "reached", "0.1.0", 1_000]);
  });
});
