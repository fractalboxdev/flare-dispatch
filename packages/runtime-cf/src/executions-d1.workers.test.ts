// Integration tests for D1ExecutionsLive — the live `executions` capability.
//
// Runs INSIDE workerd via `@cloudflare/vitest-pool-workers` (see
// `vitest.workers.config.ts` + test-support-workers.ts). Asserts the
// `executions` + `steps` rows the service writes, and pins the per-step D1
// write count (plan § 6 flags D1 hot-path writes — PR4 keeps it bounded).

import { Cause, Effect, Exit, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Executions } from "@fractalboxdev/flare-dispatch-core";
import { type ExecutionContext, makeD1ExecutionsLive } from "./executions-d1";
import { countRows, makeTestBindings, type TestBindings } from "./test-support-workers";

const EXECUTION_ID = "01TEST00000000000000000001";
const CTX: ExecutionContext = {
  repo: "owner/name",
  ref: "refs/heads/main",
  sha: "abc123",
  input: { command: "pnpm test" },
};

describe("D1ExecutionsLive", () => {
  let bindings: TestBindings;

  beforeEach(async () => {
    bindings = await makeTestBindings();
  });
  afterEach(async () => {
    await bindings.dispose();
  });
  it("preserves a real D1 finalization defect and leaves the execution unfinished", async () => {
    const layer = makeD1ExecutionsLive(bindings.db, CTX);
    await Effect.runPromise(Effect.gen(function* () {
      const executions = yield* Executions;
      yield* executions.startExecution({ id: EXECUTION_ID, run: "fixture-command", startedAt: 1000 });
    }).pipe(Effect.provide(layer)));
    await bindings.db.prepare(`CREATE TRIGGER fixture_refuse_execution_finish BEFORE UPDATE OF completed_at ON executions
      BEGIN SELECT RAISE(ABORT, 'SQLITE_TOOBIG: fixture-private-canary'); END;`).run();
    const summaryJson = JSON.stringify({ exitCode: 0, durationMs: 10, logUri: "/v1/artifacts/fixture/check.log" });
    const exit = await Effect.runPromiseExit(Effect.gen(function* () {
      const executions = yield* Executions;
      yield* executions.finishExecution({ id: EXECUTION_ID, completedAt: 2000, status: "success", summaryJson });
    }).pipe(Effect.provide(layer)));
    const defect = Exit.match(exit, { onSuccess: () => undefined,
      onFailure: cause => Option.getOrUndefined(Cause.dieOption(cause)) });
    expect(defect).toBeInstanceOf(Error);
    const wrapper = defect as Error;
    expect(wrapper.message).toContain('"operation":"finishExecution"');
    expect(wrapper.message).toContain('"errorClass":"Error"');
    expect(wrapper.message).toContain('"d1PrefixHint":"D1_ERROR"');
    expect(wrapper.message).toContain('"sqliteCodeHint":"SQLITE_CONSTRAINT"');
    expect(wrapper.message).toContain('"summaryUtf8Bytes":73');
    for (const forbidden of ["fixture-private-canary", "SQLITE_TOOBIG", "UPDATE", "owner/name", "check.log"])
      expect(wrapper.message).not.toContain(forbidden);
    expect(wrapper.cause).toBeInstanceOf(Error);
    const cause = wrapper.cause as Error;
    console.log(JSON.stringify({ operation: "finishExecution", errorClass: cause instanceof Error ? "Error" : "Other",
      ownPropertyNames: Object.getOwnPropertyNames(cause).filter(name => ["name","message","stack","cause","code"].includes(name)),
      codeFieldPresent: Object.hasOwn(cause, "code"), sqliteConstraint: cause.message.includes("SQLITE_CONSTRAINT"),
      summaryUtf8Bytes: new TextEncoder().encode(summaryJson).byteLength }));
    expect(await bindings.db.prepare("SELECT status,completed_at,summary_json FROM executions WHERE id=?")
      .bind(EXECUTION_ID).first()).toEqual({ status: "running", completed_at: null, summary_json: null });
  });
  it("keeps diagnostic metadata generic without invoking hostile provider getters", async () => {
    let getterCalls = 0;
    const provider = new Error("fixture-private-canary");
    for (const property of ["name", "message", "code", "cause"])
      Object.defineProperty(provider, property, { get: () => { getterCalls++; throw new Error("fixture getter forbidden"); } });
    const db = new Proxy(bindings.db, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(inner, method) {
          if (method === "bind") return (...values: Parameters<D1PreparedStatement["bind"]>) => wrap(inner.bind(...values));
          if (method === "run" && sql.startsWith("UPDATE executions")) return async () => { throw provider; };
          const value = Reflect.get(inner, method); return typeof value === "function" ? value.bind(inner) : value;
        } });
        return wrap(target.prepare(sql));
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const exit = await Effect.runPromiseExit(Effect.gen(function* () {
      const executions = yield* Executions;
      yield* executions.startExecution({ id: EXECUTION_ID, run: "fixture-command", startedAt: 1000 });
      yield* executions.finishExecution({ id: EXECUTION_ID, completedAt: 2000, status: "failure", summaryJson: "é💥\ud800" });
    }).pipe(Effect.provide(makeD1ExecutionsLive(db, CTX))));
    const defect = Exit.match(exit, { onSuccess: () => undefined, onFailure: cause => Option.getOrUndefined(Cause.dieOption(cause)) });
    expect(defect).toBeInstanceOf(Error);
    const message = (defect as Error).message;
    expect(message).toContain('"errorClass":"Error"');
    expect(message).toContain('"d1PrefixHint":"unknown"');
    expect(message).toContain('"sqliteCodeHint":"unknown"');
    expect(message).toContain('"summaryUtf8Bytes":9');
    expect(message).not.toContain("fixture-private-canary"); expect(getterCalls).toBe(0);
  });

  it("writes one executions row spanning start → finish", async () => {
    const layer = makeD1ExecutionsLive(bindings.db, CTX);

    await Effect.runPromise(
      Effect.gen(function* () {
        const executions = yield* Executions;
        yield* executions.startExecution({
          id: EXECUTION_ID,
          run: "offload-test",
          startedAt: 1000,
        });
        yield* executions.finishExecution({
          id: EXECUTION_ID,
          completedAt: 2000,
          status: "success",
        });
      }).pipe(Effect.provide(layer)),
    );

    // Exactly one executions row — start INSERTs, finish UPDATEs the same row.
    expect(await countRows(bindings.db, "executions")).toBe(1);

    const row = await bindings.db
      .prepare(
        `SELECT id, run, repo, ref, sha, status, started_at, completed_at, input_json
           FROM executions WHERE id = ?`,
      )
      .bind(EXECUTION_ID)
      .first<Record<string, unknown>>();

    expect(row).toMatchObject({
      id: EXECUTION_ID,
      run: "offload-test",
      repo: "owner/name",
      ref: "refs/heads/main",
      sha: "abc123",
      status: "success",
      started_at: 1000,
      completed_at: 2000,
    });
    expect(JSON.parse(String(row?.input_json))).toEqual({ command: "pnpm test" });
  });

  it("records parent_execution_id lineage for a spawned child, NULL for a top-level row", async () => {
    const layer = makeD1ExecutionsLive(bindings.db, CTX);
    const childId = "01TEST00000000000000000002";

    await Effect.runPromise(
      Effect.gen(function* () {
        const executions = yield* Executions;
        // Top-level execution — no parent.
        yield* executions.startExecution({
          id: EXECUTION_ID,
          run: "matrix-fanout",
          startedAt: 0,
        });
        // Child spawned by it — carries the parent's id.
        yield* executions.startExecution({
          id: childId,
          run: "matrix-fanout-shard",
          startedAt: 1,
          parentExecutionId: EXECUTION_ID,
        });
      }).pipe(Effect.provide(layer)),
    );

    const parent = await bindings.db
      .prepare(`SELECT parent_execution_id FROM executions WHERE id = ?`)
      .bind(EXECUTION_ID)
      .first<{ parent_execution_id: string | null }>();
    expect(parent?.parent_execution_id).toBeNull();

    const child = await bindings.db
      .prepare(`SELECT parent_execution_id FROM executions WHERE id = ?`)
      .bind(childId)
      .first<{ parent_execution_id: string | null }>();
    expect(child?.parent_execution_id).toBe(EXECUTION_ID);
  });

  it("records attempt 1 / NULL retry_of by default, and the lineage a re-run passes", async () => {
    const layer = makeD1ExecutionsLive(bindings.db, CTX);
    const rerunId = "01TEST00000000000000000003";

    await Effect.runPromise(
      Effect.gen(function* () {
        const executions = yield* Executions;
        yield* executions.startExecution({ id: EXECUTION_ID, run: "check", startedAt: 0 });
        yield* executions.startExecution({
          id: rerunId,
          run: "check",
          startedAt: 1,
          attempt: 2,
          retryOf: EXECUTION_ID,
        });
      }).pipe(Effect.provide(layer)),
    );

    const lineage = async (id: string) =>
      bindings.db
        .prepare(`SELECT attempt, retry_of FROM executions WHERE id = ?`)
        .bind(id)
        .first<{ attempt: number; retry_of: string | null }>();
    expect(await lineage(EXECUTION_ID)).toEqual({ attempt: 1, retry_of: null });
    expect(await lineage(rerunId)).toEqual({ attempt: 2, retry_of: EXECUTION_ID });
  });

  it("writes one steps row per step, each spanning start → finish", async () => {
    const layer = makeD1ExecutionsLive(bindings.db, CTX);
    const stepNames = ["checkout", "exec", "upload-log"];

    await Effect.runPromise(
      Effect.gen(function* () {
        const executions = yield* Executions;
        yield* executions.startExecution({
          id: EXECUTION_ID,
          run: "offload-test",
          startedAt: 0,
        });
        // One start + one finish per step — the inline/CF StepRunner contract.
        for (const name of stepNames) {
          yield* executions.startStep({
            executionId: EXECUTION_ID,
            name,
            startedAt: 10,
          });
          yield* executions.finishStep({
            executionId: EXECUTION_ID,
            name,
            completedAt: 20,
            status: "success",
          });
        }
      }).pipe(Effect.provide(layer)),
    );

    // Exactly one steps row per step — `finishStep` UPDATEs, never INSERTs.
    expect(await countRows(bindings.db, "steps")).toBe(stepNames.length);

    const rows = await bindings.db
      .prepare(
        `SELECT name, status, started_at, completed_at
           FROM steps WHERE execution_id = ? ORDER BY started_at, name`,
      )
      .bind(EXECUTION_ID)
      .all<{ name: string; status: string }>();

    expect(rows.results.map((r) => r.name).sort()).toEqual([...stepNames].sort());
    expect(rows.results.every((r) => r.status === "success")).toBe(true);
  });

  it("is replay-idempotent — repeated startExecution / startStep are no-ops", async () => {
    // A CF Workflow's `run` re-executes on every Worker resume, so the INSERTs
    // here run more than once. Calling `startExecution` twice and `startStep`
    // for the same `(executionId, name)` twice must NOT raise (no PK violation)
    // and must NOT duplicate rows. This is the resume-from-checkpoint guard.
    const layer = makeD1ExecutionsLive(bindings.db, CTX);

    await Effect.runPromise(
      Effect.gen(function* () {
        const executions = yield* Executions;
        // First pass.
        yield* executions.startExecution({
          id: EXECUTION_ID,
          run: "offload-test",
          startedAt: 0,
        });
        yield* executions.startStep({
          executionId: EXECUTION_ID,
          name: "exec",
          startedAt: 10,
        });
        // Second pass — simulates a Workflow resume re-running `run`.
        yield* executions.startExecution({
          id: EXECUTION_ID,
          run: "offload-test",
          startedAt: 999,
        });
        yield* executions.startStep({
          executionId: EXECUTION_ID,
          name: "exec",
          startedAt: 999,
        });
      }).pipe(Effect.provide(layer)),
    );

    // Still exactly one row each — `INSERT OR IGNORE` collapsed the replays.
    expect(await countRows(bindings.db, "executions")).toBe(1);
    expect(await countRows(bindings.db, "steps")).toBe(1);

    // The IGNOREd second insert did not overwrite the first row's values.
    const exec = await bindings.db
      .prepare(`SELECT started_at FROM executions WHERE id = ?`)
      .bind(EXECUTION_ID)
      .first<{ started_at: number }>();
    expect(exec?.started_at).toBe(0);
  });

  it("records a step failure with its error tag", async () => {
    const layer = makeD1ExecutionsLive(bindings.db, CTX);

    await Effect.runPromise(
      Effect.gen(function* () {
        const executions = yield* Executions;
        yield* executions.startExecution({
          id: EXECUTION_ID,
          run: "offload-test",
          startedAt: 0,
        });
        yield* executions.startStep({
          executionId: EXECUTION_ID,
          name: "exec",
          startedAt: 10,
        });
        yield* executions.finishStep({
          executionId: EXECUTION_ID,
          name: "exec",
          completedAt: 20,
          status: "failure",
          errorTag: "ExecFailed",
        });
      }).pipe(Effect.provide(layer)),
    );

    // This assertion is the point of the test and it did not exist: the test
    // passed no `errorTag` and checked only `status`, so it went green through
    // the entire period in which the tag was computed on every failure and
    // dropped — there was no column and the store never read the field (#80).
    const step = await bindings.db
      .prepare(`SELECT status, error_tag FROM steps WHERE execution_id = ? AND name = ?`)
      .bind(EXECUTION_ID, "exec")
      .first<{ status: string; error_tag: string | null }>();
    expect(step?.status).toBe("failure");
    expect(step?.error_tag).toBe("ExecFailed");
  });

  it("keeps a recorded error tag when the step is finished again on replay", async () => {
    const layer = makeD1ExecutionsLive(bindings.db, CTX);

    await Effect.runPromise(
      Effect.gen(function* () {
        const executions = yield* Executions;
        yield* executions.startExecution({
          id: EXECUTION_ID,
          run: "offload-test",
          startedAt: 0,
        });
        yield* executions.startStep({ executionId: EXECUTION_ID, name: "exec", startedAt: 10 });
        yield* executions.finishStep({
          executionId: EXECUTION_ID,
          name: "exec",
          completedAt: 20,
          status: "failure",
          errorTag: "ExecFailed",
        });
        // A Workflow replay re-runs the surrounding Effect, and the success
        // path carries no tag. A plain assignment would blank the reason.
        yield* executions.finishStep({
          executionId: EXECUTION_ID,
          name: "exec",
          completedAt: 20,
          status: "failure",
        });
      }).pipe(Effect.provide(layer)),
    );

    const step = await bindings.db
      .prepare(`SELECT error_tag FROM steps WHERE execution_id = ? AND name = ?`)
      .bind(EXECUTION_ID, "exec")
      .first<{ error_tag: string | null }>();
    expect(step?.error_tag).toBe("ExecFailed");
  });
});
