// The facts a check run's conclusion states, read from the intake record beside mameko's execution, placement and
// reservation rows of the same execution.
import { conclusionFactsOf } from "@fractalboxdev/flare-dispatch-github";
import { describe, expect, it } from "vitest";
import {
  bodyOf,
  admit,
  authenticated,
  harness,
  NOW,
  type Harness,
} from "./harness.test-support.ts";
import { IntakeStore } from "./store.ts";

const admitCheck = async (h: Harness) =>
  (await admit(h, authenticated({ classInput: "required" }))).executionId;

const factsOf = (h: Harness, id: string) => h.run(IntakeStore.use((s) => s.conclusionFacts(id)));

const exec = (h: Harness, sql: string, ...params: unknown[]) =>
  h.db.sqlite.prepare(sql).run(...(params as never[]));

describe("the conclusion facts of an execution", () => {
  it("[FD-GH-015] reads the class, the claim record and the reservation of a concluded execution", async () => {
    const h = await harness({
      resolve: (r) => ({
        _tag: "Class",
        class: r.classInput ?? "required",
        labels: [],
        alarm: null,
      }),
    });
    const id = await admitCheck(h);
    exec(
      h,
      `update placements set leased_kind = 'device', accepted_kind = 'device', cloud_won = 0, claim_latency_ms = 4000
       where execution_id = ?`,
      id,
    );
    exec(
      h,
      `insert into reservations (execution_id, class, hold_micro_usd, state, metered_micro_usd, updated_at)
       values (?, 'required', 20000, 'settled', 12000, ?)`,
      id,
      NOW,
    );
    exec(
      h,
      "update executions set status = 'failure', reason = 'lint: 3 errors', finished_at = ? where id = ?",
      NOW + 60_000,
      id,
    );
    const facts = await factsOf(h, id);
    const record = await h.run(IntakeStore.use((s) => s.get(id)));
    expect(facts).toMatchObject({
      name: "flare-dispatch/check:ci",
      headSha: record?.sha,
      attempt: 1,
      className: "required",
      status: "failure",
      reason: "lint: 3 errors",
      placement: { claimLatencyMs: 4000, acceptedKind: "device", cloudWon: false },
      reservation: { holdMicroUsd: 20000, state: "settled", meteredMicroUsd: 12000 },
    });
    expect(conclusionFactsOf(facts!, undefined).details).toEqual({
      class: "required",
      executor_kind: "device",
      placement_reason: "device entry won",
      queue_age_ms: 4000,
      reserved_micro_usd: 20000,
      settled_micro_usd: 12000,
    });
  });

  it("[FD-GH-008] every attempt of a check family reads the same check-run name and its own attempt", async () => {
    const h = await harness({
      resolve: (r) => ({
        _tag: "Class",
        class: r.classInput ?? "required",
        labels: [],
        alarm: null,
      }),
    });
    const first = await admitCheck(h);
    const record = (await h.run(IntakeStore.use((s) => s.get(first))))!;
    exec(
      h,
      `insert into executions (id, scope_id, run, class, status, enqueued_at) values ('retry-2', ?, 'check', 'required', 'success', ?)`,
      record.repo,
      NOW,
    );
    await h.run(
      IntakeStore.use((s) =>
        s.put({ ...record, executionId: "retry-2", attempt: 2, familyRoot: first }),
      ),
    );
    const [one, two] = [await factsOf(h, first), await factsOf(h, "retry-2")];
    expect(one?.name).toBe("flare-dispatch/check:ci");
    expect(two?.name).toBe(one?.name);
    expect([one?.attempt, two?.attempt]).toEqual([1, 2]);
    expect(two?.placement).toBeNull();
    expect(two?.reservation).toBeNull();
  });

  it("an execution with no intake record has no facts", async () => {
    const h = await harness();
    expect(await factsOf(h, "unknown")).toBeNull();
  });
});
