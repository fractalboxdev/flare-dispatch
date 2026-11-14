// The control plane's half of a run's intents over D1: the executor channel stages an `exec.intents` batch under
// `run:<key>` (MAMEKO-PROTO-051), accepts the epoch's result, and the `Execution` workflow's `applyOutbox` writes the
// staged intents whose kind is applied for the accepted outcome (MAMEKO-RUN-078). The settings come from the profile
// through `controlPlaneSettings`, as the control plane derives its channel and stage configuration.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import {
  controlPlaneSettings,
  ExecutionSteps,
  type ExecutionOutcome,
} from "@fractalboxdev/mameko-coordinator";
import { d1StageIntents } from "@fractalboxdev/mameko-host-cloudflare/d1-checkpoints";
import {
  runD1Migrations,
  type D1Like,
  type D1Statement,
} from "@fractalboxdev/mameko-host-cloudflare/d1";
import { d1ExecutionSteps } from "@fractalboxdev/mameko-host-cloudflare/d1-execution";
import type { KeyedIntent, RunResult } from "@fractalboxdev/mameko-run";
import { Effect, Match } from "effect";

const statement = (
  db: DatabaseSync,
  sql: string,
  params: readonly unknown[] = [],
): D1Statement => ({
  bind: (...values) => statement(db, sql, values),
  run: async () => db.prepare(sql).run(...(params as SQLInputValue[])),
  all: async () => ({ results: db.prepare(sql).all(...(params as SQLInputValue[])) as unknown[] }),
});

/** A D1 over Node's SQLite whose `batch` runs in one transaction, as D1 runs it atomically. */
const sqliteD1 = (): D1Like & { readonly sqlite: DatabaseSync } => {
  const db = new DatabaseSync(":memory:");
  return {
    sqlite: db,
    prepare: (sql) => statement(db, sql),
    batch: async (statements) => {
      db.exec("begin");
      try {
        const out = [];
        for (const s of statements) out.push(await s.all());
        db.exec("commit");
        return out;
      } catch (e) {
        db.exec("rollback");
        throw e;
      }
    },
  };
};

const settings = controlPlaneSettings(buildProfile("production"));
const EXECUTOR = "cf-1";
const EPOCH = 1;

/** One execution of `run` in `scope`, admitted and leased to one executor at epoch 1. */
export const leasedPlane = async (executionId: string, run: string, scope: string) => {
  const db = sqliteD1();
  await runD1Migrations(db);
  db.sqlite
    .prepare(
      `insert into executions (id, scope_id, run, class, status, enqueued_at) values (?, ?, ?, 'release', 'running', ?)`,
    )
    .run(executionId, scope, run, Date.now());
  db.sqlite
    .prepare(
      `insert into placements (execution_id, state, epoch, executor_id) values (?, 'leased', ?, ?)`,
    )
    .run(executionId, EPOCH, EXECUTOR);
  const kinds = settings.channel.intentKinds;
  return {
    /** The channel's answer to the run's `exec.intents` batch. */
    stage: (intents: readonly KeyedIntent[]) =>
      Effect.runPromise(
        d1StageIntents(db, {
          executionId,
          epoch: EPOCH,
          executorId: EXECUTOR,
          intents,
          effectClassOf: (kind) => (Object.hasOwn(kinds, kind) ? kinds[kind] : undefined),
        }),
      ),
    /** The channel accepts the epoch's `exec.result`. */
    accept: () =>
      db.sqlite
        .prepare(
          "update placements set state = 'accepted', accepted_epoch = ? where execution_id = ? and state = 'leased'",
        )
        .run(EPOCH, executionId),
    /** The workflow's `apply-outbox` stage for the accepted outcome. */
    applyOutbox: (outcome: ExecutionOutcome) =>
      Effect.runPromise(
        ExecutionSteps.use((steps) => steps.applyOutbox(executionId, outcome, EPOCH)).pipe(
          Effect.provide(
            d1ExecutionSteps(db, { ...settings.execution, meteredCost: () => Effect.succeed(0) }),
          ),
        ),
      ),
    /** Every row the stage and apply-outbox write. */
    snapshot: () => ({
      outbox: db.sqlite
        .prepare(
          "select id, intent_key, kind, tier, payload_json, state from outbox order by tier, id",
        )
        .all(),
      staged: db.sqlite
        .prepare("select intent_key, kind, committed from staged_intents order by intent_key")
        .all(),
      executions: db.sqlite.prepare("select id, status, reason from executions").all(),
    }),
    /** The effect-tier rows: the run's intents the outbox holds. */
    effects: () =>
      db.sqlite
        .prepare(
          "select id, intent_key, kind, payload_json from outbox where tier = 'effect' order by id",
        )
        .all() as { id: string; intent_key: string; kind: string; payload_json: string }[],
  };
};

/** The engine's outcome for a run result at the plane's epoch. */
export const outcomeOf = (result: RunResult): ExecutionOutcome =>
  Match.valueTags(result, {
    success: (): ExecutionOutcome => ({ _tag: "Success", epoch: EPOCH }),
    failure: ({ reason }): ExecutionOutcome => ({ _tag: "Failure", reason, epoch: EPOCH }),
    cancelled: ({ cause }): ExecutionOutcome => ({ _tag: "Cancelled", cause }),
    skipped: ({ detail }): ExecutionOutcome => ({ _tag: "Skipped", detail, epoch: EPOCH }),
  });

/** The lease's run payload for a catalogue run's workflow. */
export const runPayload = <I>(executionId: string, run: string, scope: string, input: I) => ({
  workflow_version: 1,
  execution_id: executionId,
  run,
  run_digest: "sha256:none",
  run_version: "2.0.0",
  scope_id: scope,
  request_context: {},
  class: "release",
  epoch: EPOCH,
  deadline_at: Date.now() + 3_600_000,
  attempt: 0,
  input,
});
