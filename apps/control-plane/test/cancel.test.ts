// The API's cancel through mameko's cancel of one execution: the execution row records the declared cause, and its
// workflow and lease are cancelled.
import { Cancellation } from "@fractalboxdev/flare-dispatch-api/ports";
import { d1Admission } from "@fractalboxdev/flare-dispatch-intake";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { API_CANCEL_CAUSE, intakeCancellation } from "../src/intake-port.ts";
import { seedExecution, type TestD1 } from "./conclude.test-support.ts";

const cancelThrough = (db: TestD1, executionId: string) => {
  const workflowCancels: { executionId: string; cause: string }[] = [];
  const admission = d1Admission(db, buildProfile("production"), {
    cancelExecution: (id, cause) =>
      Effect.sync(() => void workflowCancels.push({ executionId: id, cause })),
  });
  const done = Effect.runPromise(
    Cancellation.use((c) => c.cancel({ executionId, identity: "op", requestId: "req-1" })).pipe(
      Effect.provide(intakeCancellation.pipe(Layer.provide(admission))),
    ),
  );
  return done.then(() => workflowCancels);
};

const statusOf = (db: TestD1, executionId: string) =>
  db.sqlite.prepare("select status, reason from executions where id = ?").get(executionId);

describe("the API's execution cancel", () => {
  it("records a live execution cancelled(operator-cancel) and cancels its workflow and lease", async () => {
    const db = await migratedD1();
    await seedExecution(db, "exec-1", "pending");
    expect(await cancelThrough(db, "exec-1")).toEqual([
      { executionId: "exec-1", cause: API_CANCEL_CAUSE },
    ]);
    expect(statusOf(db, "exec-1")).toEqual({ status: "cancelled", reason: "operator-cancel" });
  });

  it("leaves a terminal execution unchanged", async () => {
    const db = await migratedD1();
    await seedExecution(db, "exec-1", "success");
    expect(await cancelThrough(db, "exec-1")).toEqual([]);
    expect(statusOf(db, "exec-1")).toEqual({ status: "success", reason: null });
  });
});
