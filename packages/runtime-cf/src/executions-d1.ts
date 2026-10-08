// @fractalboxdev/flare-dispatch-runtime-cf — D1ExecutionsLive: the live `executions` capability.
//
// Backs `ExecutionsService` with the D1 binding: one row in `executions` per
// run invocation, one row in `steps` per step transition (INSERT at entry,
// UPDATE at exit). Schema is infra/d1-schema.sql verbatim.
//
// --- One design seam, documented ---------------------------------------------
//
// `ExecutionsService.startExecution` (defined in @fractalboxdev/flare-dispatch-core) carries
// only `{ id, run, startedAt }`, but the `executions` table has NOT NULL
// `repo`, `ref`, `sha`, `input_json`, `status` columns. The core interface is
// fixed and run-agnostic, so the missing columns are supplied *out of band*:
// `makeD1ExecutionsLive` takes an `ExecutionContext` ({ repo, ref, sha, input })
// that `RunWorkflow` derives from the dispatch event. The Layer closes over it;
// `startExecution` then has every NOT NULL column. This keeps the core service
// contract narrow while satisfying the real schema — the Layer is the place
// runtime-specific context is injected.
//
// D1 write rate (specs/pm/plan.md § 6): this runtime writes exactly two D1
// statements per step (one INSERT, one UPDATE) plus two for the execution.
// `offload-test` (3 run-body steps) is therefore 8 writes — the PR4 integration
// test pins this with a row-count assertion.
//
// --- Replay idempotency ------------------------------------------------------
//
// A CF Workflow's `run(event, step)` re-executes top-to-bottom on every Worker
// eviction/resume — only `WorkflowStep.do` *results* are memoized. Every
// `ExecutionsService` call here runs OUTSIDE a `step.do` (`startExecution` from
// `RunWorkflow`, `startStep`/`finishStep` from `StepRunnerCloudflare` around
// the checkpoint), so each one re-runs on resume. The INSERTs must therefore be
// idempotent or a resume would PK-violate (`executions`) or duplicate rows
// (`steps`):
//
//   * both INSERTs are `INSERT OR IGNORE` — a replayed insert is a silent
//     no-op once the row already exists;
//   * the `steps` PK is DETERMINISTIC — `${executionId}:${name}:${attempt}` —
//     so a replay computes the same PK and `OR IGNORE` collapses it (a fresh
//     random PK would defeat `OR IGNORE` and accumulate duplicates);
//   * `finishExecution` / `finishStep` are plain `UPDATE`s, idempotent by
//     construction — re-running them just rewrites the same row.
//
// This preserves the "an evicted Worker resumes from the last completed step"
// property the architecture spec sells (specs/01-architecture.md § Workflow
// Engine). There is no non-deterministic call left in this layer.
//
// Spec: specs/05-byoc.md § D1 schema, specs/pm/plan.md § PR4.

import { Effect, Layer, Schema } from "effect";
import { Executions, type ExecutionsService } from "@fractalboxdev/flare-dispatch-core";

const Operation = Schema.Literal("startExecution", "finishExecution", "startStep", "finishStep");
const ErrorClass = Schema.Literal("Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError", "EvalError", "unknown");
const D1Prefix = Schema.Literal("D1_ERROR", "D1_EXEC_ERROR", "D1_TYPE_ERROR", "D1_COLUMN_NOTFOUND", "unknown");
const SqliteCode = Schema.Literal("SQLITE_ABORT", "SQLITE_AUTH", "SQLITE_BUSY", "SQLITE_CANTOPEN", "SQLITE_CONSTRAINT",
  "SQLITE_CORRUPT", "SQLITE_EMPTY", "SQLITE_ERROR", "SQLITE_FORMAT", "SQLITE_FULL", "SQLITE_INTERNAL", "SQLITE_INTERRUPT",
  "SQLITE_IOERR", "SQLITE_LOCKED", "SQLITE_MISMATCH", "SQLITE_MISUSE", "SQLITE_NOLFS", "SQLITE_NOMEM", "SQLITE_NOTADB",
  "SQLITE_NOTFOUND", "SQLITE_NOTICE", "SQLITE_PERM", "SQLITE_PROTOCOL", "SQLITE_RANGE", "SQLITE_READONLY", "SQLITE_SCHEMA",
  "SQLITE_TOOBIG", "SQLITE_WARNING", "unknown");
const Diagnostic = Schema.Struct({ operation: Operation, errorClass: ErrorClass, d1PrefixHint: D1Prefix,
  sqliteCodeHint: SqliteCode, summaryUtf8Bytes: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())) });
const DIAGNOSTIC_TEXT_CHARACTERS = 4096;

/** Error property getters carry no diagnostic authority; only own data strings are inspected. */
const ownMessage = (cause: unknown): string | undefined => {
  try {
    if (!(cause instanceof Error)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(cause, "message");
    return typeof descriptor?.value === "string" && descriptor.value.length <= DIAGNOSTIC_TEXT_CHARACTERS
      ? descriptor.value : undefined;
  } catch { return undefined; }
};
const builtinClass = (cause: unknown): typeof ErrorClass.Type => {
  try {
    if (cause instanceof TypeError) return "TypeError";
    if (cause instanceof RangeError) return "RangeError";
    if (cause instanceof SyntaxError) return "SyntaxError";
    if (cause instanceof ReferenceError) return "ReferenceError";
    if (cause instanceof URIError) return "URIError";
    if (cause instanceof EvalError) return "EvalError";
    if (cause instanceof Error) return "Error";
  } catch { /* Hostile prototype access contributes only the generic category. */ }
  return "unknown";
};
/** UTF8 size uses bounded temporary chunks and keeps surrogate pairs in the same chunk. */
const summaryBytes = (value: string): number => {
  const encoder = new TextEncoder();
  let bytes = 0;
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + DIAGNOSTIC_TEXT_CHARACTERS);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
    bytes += encoder.encode(value.slice(offset, end)).byteLength;
    offset = end;
  }
  return bytes;
};
/** Prefix/suffix hints are observational, never authenticated provider codes or retry/verdict inputs. */
const failureError = (operation: typeof Operation.Type, cause: unknown, summaryJson?: string): Error => {
  const message = ownMessage(cause);
  const prefix = message?.match(/^(D1_ERROR|D1_EXEC_ERROR|D1_TYPE_ERROR|D1_COLUMN_NOTFOUND): /)?.[1];
  const suffix = prefix === undefined ? undefined : message?.match(/: (SQLITE_[A-Z]+)$/)?.[1];
  const diagnostic = Schema.decodeUnknownSync(Diagnostic)({ operation, errorClass: builtinClass(cause),
    d1PrefixHint: Schema.is(D1Prefix)(prefix) ? prefix : "unknown",
    sqliteCodeHint: Schema.is(SqliteCode)(suffix) ? suffix : "unknown",
    ...(typeof summaryJson === "string" ? { summaryUtf8Bytes: summaryBytes(summaryJson) } : {}),
  });
  return new Error(`D1ExecutionsLive: ${operation} failed ${JSON.stringify(diagnostic)}`, { cause });
};

/**
 * The run-invocation context the `executions` row needs but the core
 * `ExecutionsService` interface does not carry — supplied by `RunWorkflow`
 * from the dispatch event.
 */
export type ExecutionContext = {
  /** "owner/name". */
  readonly repo: string;
  /** git ref, e.g. "refs/heads/main". */
  readonly ref: string;
  /** head SHA. */
  readonly sha: string;
  /** the decoded run input, persisted as `input_json`. */
  readonly input: unknown;
};

/**
 * Build the live `Executions` Layer bound to a D1 database.
 *
 * @param db   the D1 binding (`env.RUNS_METADATA`).
 * @param ctx  the repo/ref/sha/input the `executions` row requires.
 */
export const makeD1ExecutionsLive = (
  db: D1Database,
  ctx: ExecutionContext,
): Layer.Layer<Executions> => {
  // A D1 write wrapped as an Effect — `tryPromise` keeps a binding failure in
  // the Effect channel rather than escaping as a rejected Promise. The service
  // contract is `Effect.Effect<void>` (no typed error), so a write failure
  // surfaces as a defect: a D1 outage mid-run is genuinely exceptional and
  // should fail the execution loudly, not be silently swallowed.
  const run = (label: typeof Operation.Type, stmt: () => Promise<D1Result | D1Response>, summaryJson?: string): Effect.Effect<void> =>
    Effect.tryPromise({
      try: () => stmt().then(() => undefined),
      catch: (cause) => failureError(label, cause, summaryJson),
    }).pipe(Effect.orDie);

  const service: ExecutionsService = {
    startExecution: ({ id, run: runName, startedAt, parentExecutionId, attempt, retryOf }) =>
      run("startExecution", () =>
        db
          // `OR IGNORE`: the PK `id` is deterministic (the executionId), so a
          // replayed insert on Workflow resume is a no-op, not a PK violation.
          // `parent_execution_id` is NULL for a top-level execution and the
          // spawning parent's id for a `spawnChildRun` child — the lineage a
          // fan-out parent reads back to join on its children. `attempt` /
          // `retry_of` tie a check-run re-run to the family it retries
          // (infra/migrations/0007) — 1 / NULL for every dispatched execution.
          .prepare(
            `INSERT OR IGNORE INTO executions
               (id, run, repo, ref, sha, status, started_at, input_json, parent_execution_id,
                attempt, retry_of)
             VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            runName,
            ctx.repo,
            ctx.ref,
            ctx.sha,
            startedAt,
            JSON.stringify(ctx.input),
            parentExecutionId ?? null,
            attempt ?? 1,
            retryOf ?? null,
          )
          .run(),
      ),

    finishExecution: ({ id, completedAt, status, summaryJson }) =>
      run("finishExecution", () =>
        summaryJson === undefined
          ? db
              .prepare(
                `UPDATE executions
                   SET status = ?, completed_at = ?
                 WHERE id = ?`,
              )
              .bind(status, completedAt, id)
              .run()
          : db
              .prepare(
                `UPDATE executions
                   SET status = ?, completed_at = ?, summary_json = ?
                 WHERE id = ?`,
              )
              .bind(status, completedAt, summaryJson, id)
              .run(),
        summaryJson,
      ),

    startStep: ({ executionId, name, startedAt }) =>
      run("startStep", () =>
        db
          // `OR IGNORE` + a DETERMINISTIC PK: a replayed insert on Workflow
          // resume recomputes the same `${executionId}:${name}:${attempt}` id
          // and is collapsed to a no-op — no duplicate `steps` rows. A random
          // PK would defeat this and accumulate a row per replay.
          .prepare(
            `INSERT OR IGNORE INTO steps
               (id, execution_id, name, status, started_at, attempt)
             VALUES (?, ?, ?, 'running', ?, 1)`,
          )
          // The PK is `${executionId}:${name}:${attempt}` (attempt = 1 in V0).
          // `(execution_id, name)` remains the logical key `finishStep` UPDATEs.
          .bind(`${executionId}:${name}:1`, executionId, name, startedAt)
          .run(),
      ),

    finishStep: ({ executionId, name, completedAt, status, errorTag }) =>
      run("finishStep", () =>
        db
          .prepare(
            // `COALESCE(?, error_tag)` rather than a plain assignment: the
            // success path passes no tag, and a step that is finished twice
            // (Workflow replay re-runs this UPDATE) must not have a recorded
            // reason overwritten with NULL by the second call.
            `UPDATE steps
               SET status = ?, completed_at = ?, error_tag = COALESCE(?, error_tag)
             WHERE execution_id = ? AND name = ?`,
          )
          .bind(status, completedAt, errorTag ?? null, executionId, name)
          .run(),
      ),
  };

  return Layer.succeed(Executions, service);
};
