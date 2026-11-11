// The child-conclusions pass reads through indexes on the migrated store: the minute tick reads the parents in the
// lookback and their children, never every execution (FD-GH-020).
import { CHILDREN, migrateChildConclusions } from "@fractalboxdev/flare-dispatch-github";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

describe("the child-conclusions read", () => {
  it("[FD-GH-020] reads executions through executions_finished and executions_parent, with no scan", async () => {
    const db = await migratedD1();
    await Effect.runPromise(migrateChildConclusions(db));
    const { results } = await db.prepare(`explain query plan ${CHILDREN}`).bind(0).all();
    const steps = (results as readonly { detail: string }[]).map((r) => r.detail);
    expect(steps.filter((d) => d.startsWith("SCAN"))).toEqual([]);
    expect(steps.some((d) => d.includes("executions_finished"))).toBe(true);
    expect(steps.some((d) => d.includes("executions_parent"))).toBe(true);
  });

  it("runs again on a store that already has the indexes", async () => {
    const db = await migratedD1();
    await Effect.runPromise(migrateChildConclusions(db));
    await Effect.runPromise(migrateChildConclusions(db));
  });
});
