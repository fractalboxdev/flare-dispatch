// The child-conclusions pass reads through indexes on the migrated store: the minute tick reads the parents in the
// durable backlog and their children, bounded per pass (FD-GH-020).
import {
  CHILDREN,
  CHILD_CONCLUSIONS_BATCH,
  insertChildConclusions,
  migrateChildConclusions,
} from "@fractalboxdev/flare-dispatch-github";
import { insertOutboxRows } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { newRow } from "@fractalboxdev/mameko-kernel";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { concludeKindOf } from "../src/config.ts";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

describe("the child-conclusions read", () => {
  it("[FD-GH-020] reads executions through executions_finished and executions_parent, with no scan", async () => {
    const db = await migratedD1();
    await Effect.runPromise(migrateChildConclusions(db));
    const { results } = await db
      .prepare(`explain query plan ${CHILDREN}`)
      .bind(Date.now(), CHILD_CONCLUSIONS_BATCH)
      .all();
    const steps = (results as readonly { detail: string }[]).map((r) => r.detail);
    expect(steps.filter((d) => d.startsWith("SCAN"))).toEqual([]);
    expect(steps.some((d) => d.includes("executions_finished"))).toBe(true);
    expect(steps.some((d) => d.includes("executions_parent"))).toBe(true);
  });

  it("[FD-GH-020] resumes a bounded child-conclusion backlog after an outage longer than one hour", async () => {
    const db = await migratedD1();
    await Effect.runPromise(migrateChildConclusions(db));
    const now = 10 * 86_400_000;
    db.sqlite
      .exec(`insert into executions (id, scope_id, run, class, status, enqueued_at, finished_at)
      values ('old-parent', 'acme/app', 'offload-test', 'required', 'success', 0, ${now - 3 * 86_400_000}),
        ('new-parent', 'acme/app', 'offload-test', 'required', 'success', 0, ${now - 10_000})`);
    const old = Array.from(
      { length: CHILD_CONCLUSIONS_BATCH + 2 },
      (_, i) => `old-${String(i).padStart(3, "0")}`,
    );
    const children = [...old, "new-child", "already-concluded"];
    for (const id of children)
      db.sqlite
        .prepare(`insert into executions (id, scope_id, run, class, status, reason, enqueued_at, parent_id)
        values (?, 'acme/app', 'gate-job', 'required', 'cancelled', 'parent-ended', 0, ?)`)
        .run(id, id === "new-child" ? "new-parent" : "old-parent");
    const makeRow = (id: string, kind: string, key: string) => ({
      id: `${id}:${key}`,
      limitKey: "7",
      tier: "effect" as const,
      priority: 0,
      classRank: 1,
      drawsReserve: false,
      intent: {
        executionId: id,
        scopeId: "acme/app",
        intentKey: key,
        kind,
        payload: {},
        payloadDigest: "test",
        effectClass: "adoptable" as const,
        attempts: 0,
      },
      row: newRow({ effectClass: "adoptable", insertedAt: 0 }),
    });
    await insertOutboxRows(
      db,
      children.map((id) => makeRow(id, "check.open", "cp:check:open")),
    );
    const done = makeRow("already-concluded", "check.conclude", "run:previous-conclusion");
    await insertOutboxRows(db, [
      { ...done, row: { ...done.row, state: "applied", appliedAt: now - 1 } },
    ]);
    const kind = concludeKindOf(buildProfile("production"));
    expect(await Effect.runPromise(insertChildConclusions(db, kind, now))).toEqual(
      old.slice(0, CHILD_CONCLUSIONS_BATCH),
    );
    expect(await Effect.runPromise(insertChildConclusions(db, kind, now + 60_000))).toEqual([
      ...old.slice(CHILD_CONCLUSIONS_BATCH),
      "new-child",
    ]);
    expect(await Effect.runPromise(insertChildConclusions(db, kind, now + 120_000))).toEqual([]);
    expect(
      db.sqlite
        .prepare("select count(*) as n from outbox where intent_key = 'cp:check:conclude'")
        .get(),
    ).toMatchObject({ n: children.length - 1 });
  });

  it("runs again on a store that already has the indexes", async () => {
    const db = await migratedD1();
    await Effect.runPromise(migrateChildConclusions(db));
    await Effect.runPromise(migrateChildConclusions(db));
  });

  it("[FD-GH-058] a child's cp:check:conclude row draws the rate limit's reserve, as the check.conclude kind does", () => {
    for (const deployment of ["development", "production"] as const)
      expect(concludeKindOf(buildProfile(deployment))).toMatchObject({
        tier: "outcome",
        drawsReserve: true,
      });
  });
});
