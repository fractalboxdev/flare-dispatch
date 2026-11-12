// The minute tick's two record units (specs/github-output.md § Job and verdict records), active where the profile
// carries the record kinds, which it does where the overlay sets `records.url` from phase 2 (FD-GH-093):
// `verdict-records` inserts one `verdict.record` ops intent for each terminal execution that has none (FD-GH-094),
// holding the scan and findings the run reported under the `report` member of its check payloads (FD-GH-096), and
// `record-undelivered` pages once for each `job.record` or `verdict.record` row that reaches `refused` or `expired`
// (FD-GH-102). Neither unit writes an execution row or a check-run row, so a record that fails to arrive leaves the
// execution's verdict and its check run as they are.
import {
  checkConclusion,
  concludedVerdictOf,
  decodeRunReport,
  OutcomePayload,
  recordedVerdict,
  Verdict,
  verdictRecordPayload,
  type Conclusion,
  type RunReport,
} from "@fractalboxdev/flare-dispatch-github";
import {
  RECORD_KINDS,
  RECORDS_LIMIT_KEY,
  type Profile,
} from "@fractalboxdev/flare-dispatch-profile";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect, Option, Schema } from "effect";
import { insertOpsIntent } from "./ops-intents.ts";
import { raiseOnce, type RaiseResult } from "./raise.ts";

/** The kind of the record of one terminal execution. */
export const VERDICT_RECORD_KIND = "verdict.record";

/** The ops intent key of an execution's `verdict.record` (FD-GH-094); the outbox stores it as `ops:<key>`. */
export const verdictRecordKey = (executionId: string) => `verdict-record:${executionId}`;

/** Whether the profile carries the record kinds, which it does only where the overlay sets `records.url`. */
export const recordsEnabled = (profile: Profile): boolean =>
  profile.intent_kinds[VERDICT_RECORD_KIND] !== undefined;

/** The records one pass inserts or pages for; later passes continue from the remaining backlog. */
export const RECORDS_BATCH = 100;

/** The control plane's store could not be read; the next tick tries again. */
export class RecordsUnavailable extends Schema.TaggedError<RecordsUnavailable>()(
  "RecordsUnavailable",
  { message: Schema.String },
) {}

const attempt = <A>(what: string, f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (e) => new RecordsUnavailable({ message: `${what}: ${e}` }),
  });

interface TerminalRow {
  readonly id: string;
  readonly scope_id: string;
  readonly run: string;
  readonly class: string;
  readonly status: string;
  readonly reason: string | null;
  readonly sha: string;
  readonly ref: string;
  readonly trigger: string;
  readonly epoch: number;
  readonly check_name: string | null;
  readonly concluded_json: string | null;
}

/**
 * The oldest terminal executions with no `verdict.record` row, bounded by the pass limit, with no age cutoff, so an
 * outage leaves no execution unrecorded. Each reads its intake record (commit SHA, ref, trigger), the epoch of its
 * accepted lease, else of its latest grant, and 0 for an execution never granted a lease; the check name from its
 * `cp:check:open` row, which admission inserts for exactly the executions that own a check run; and its first applied
 * `check.conclude` row, whose verdict is the conclusion the check run carries. An execution without an intake record
 * has no commit or ref to record and is not read.
 */
export const TERMINAL_UNRECORDED = `select e.id, e.scope_id, e.run, coalesce(e.class, r.class) as class, e.status,
    e.reason, r.sha, r.ref, r.trigger, coalesce(p.accepted_epoch, p.leased_epoch, 0) as epoch,
    (select json_extract(o.payload_json, '$.name') from outbox o
      where o.execution_id = e.id and o.intent_key = 'cp:check:open') as check_name,
    (select o.payload_json from outbox o
      where o.execution_id = e.id and o.kind = 'check.conclude' and o.state = 'applied'
      order by o.applied_at, o.id limit 1) as concluded_json
  from executions e
  join intake_records r on r.execution_id = e.id
  left join placements p on p.execution_id = e.id
  where e.finished_at <= ? and e.status not in ('pending', 'running')
    and not exists (select 1 from outbox v
      where coalesce(v.execution_id, '') = '' and v.scope_id = e.scope_id
        and v.intent_key = 'ops:verdict-record:' || e.id)
  order by e.finished_at, e.id limit ?`;

const StatedVerdict = Schema.Struct({ verdict: Verdict });

/**
 * The conclusion the check run carries: none until a `check.conclude` row is applied, as for a `halt` outcome whose
 * delivery key is paused; otherwise the conclusion of the verdict that row stated, a full payload's or a child's
 * `{ verdict }`, or mameko's `{ outcome }`, and the recorded verdict's for a row that states neither.
 */
const conclusionOf = (concludedJson: string | null, recorded: Verdict): Conclusion | null => {
  if (concludedJson === null) return null;
  const payload: unknown = JSON.parse(concludedJson);
  const stated = Schema.decodeUnknownOption(StatedVerdict)(payload);
  if (Option.isSome(stated)) return checkConclusion(stated.value.verdict).conclusion;
  const outcome = Schema.decodeUnknownOption(OutcomePayload)(payload);
  return checkConclusion(
    Option.isSome(outcome) ? concludedVerdictOf(outcome.value.outcome) : recorded,
  ).conclusion;
};

/** The kinds whose run-emitted payload may carry the run's `report` of its scan and findings. */
export const REPORT_KINDS = ["check.summary", "check.annotations"] as const;

/**
 * The run-emitted rows of the executions a pass records that carry a `report` member: each execution's `check.summary`
 * rows ahead of its `check.annotations` rows, each kind by intent key. One query reads every execution of the pass.
 */
export const REPORTED_RESULTS = `select o.execution_id, o.payload_json from outbox o
  where o.execution_id in (select value from json_each(?))
    and o.kind in (${REPORT_KINDS.map((k) => `'${k}'`).join(", ")})
    and json_extract(o.payload_json, '$.report') is not null
  order by o.execution_id, case o.kind when 'check.summary' then 0 else 1 end, o.intent_key`;

interface ReportedRow {
  readonly execution_id: string;
  readonly payload_json: string;
}

/** Each execution's reports of its scan and findings, read from its own `check.summary` and `check.annotations` rows. */
const reportsOf = (db: D1Like, executionIds: readonly string[]) =>
  Effect.gen(function* () {
    const byExecution = new Map<string, RunReport[]>();
    if (executionIds.length === 0) return byExecution;
    const { results } = yield* attempt("reported results", () =>
      db.prepare(REPORTED_RESULTS).bind(JSON.stringify(executionIds)).all(),
    );
    for (const row of results as readonly ReportedRow[]) {
      const decoded = decodeRunReport(JSON.parse(row.payload_json));
      if (Option.isNone(decoded)) continue;
      const held = byExecution.get(row.execution_id) ?? [];
      held.push(decoded.value.report);
      byExecution.set(row.execution_id, held);
    }
    return byExecution;
  });

/**
 * Inserts one `verdict.record` ops intent through `insertOpsIntent`, keyed `verdict-record:<execution_id>` on the
 * `records` delivery key, for each terminal execution that has no such row (FD-GH-094), and answers the executions it
 * inserted for. Each record holds the scan and findings the execution's run reported (FD-GH-096). A repeat inserts
 * nothing for an execution already recorded.
 */
export const insertVerdictRecords = (db: D1Like, profile: Profile, now: number) =>
  Effect.gen(function* () {
    const { results } = yield* attempt("terminal executions", () =>
      db.prepare(TERMINAL_UNRECORDED).bind(now, RECORDS_BATCH).all(),
    );
    const rows = results as readonly TerminalRow[];
    const reports = yield* reportsOf(
      db,
      rows.map((r) => r.id),
    );
    const inserted: string[] = [];
    for (const row of rows) {
      const verdict = recordedVerdict(row.status, row.reason);
      if (verdict === null) continue;
      yield* insertOpsIntent(
        db,
        profile,
        {
          scopeId: row.scope_id,
          intentKey: verdictRecordKey(row.id),
          kind: VERDICT_RECORD_KIND,
          payload: verdictRecordPayload({
            executionId: row.id,
            epoch: row.epoch,
            run: row.run,
            repository: row.scope_id,
            commitSha: row.sha,
            ref: row.ref,
            class: row.class,
            trigger: row.trigger,
            verdict,
            conclusion: conclusionOf(row.concluded_json, verdict),
            checkName: row.check_name,
            reports: reports.get(row.id) ?? [],
          }),
          limitKey: RECORDS_LIMIT_KEY,
        },
        now,
      );
      inserted.push(row.id);
    }
    return inserted;
  });

/** The page alarm of one undelivered record. */
export const RECORD_UNDELIVERED = "record-undelivered";

/** The dedupe key of the alarm for one outbox row: each undelivered record pages on its own. */
export const recordUndeliveredKey = (rowId: string) => `${RECORD_UNDELIVERED}:${rowId}`;

interface UndeliveredRow {
  readonly id: string;
  readonly kind: string;
  readonly state: "refused" | "expired";
  readonly last_error: string | null;
  readonly execution_id: string | null;
}

const kindList = RECORD_KINDS.map((k) => `'${k}'`).join(", ");

/**
 * The record rows that reached `refused` or `expired` and have not paged. A row's state is final, so its alarm is
 * sent once; a delivery that failed leaves the alarm's `updated_at` at 0 (raise.ts), and the row is read again. The
 * execution is the row's own, or for an ops `verdict.record` row, the one its payload records.
 */
export const UNDELIVERED_RECORDS = `select o.id, o.kind, o.state, o.last_error,
    coalesce(o.execution_id, json_extract(o.payload_json, '$.execution_id')) as execution_id
  from outbox o
  where o.state in ('refused', 'expired') and o.kind in (${kindList})
    and not exists (select 1 from fd_alarms a
      where a.dedupe_key = '${RECORD_UNDELIVERED}:' || o.id and a.updated_at > 0)
  order by o.inserted_at, o.id limit ?`;

/**
 * Raises the page alarm `record-undelivered` naming the execution for each `job.record` or `verdict.record` row that
 * reached `refused` or `expired` (FD-GH-102), and answers each row's execution and what its raise did. It writes only
 * the alarm store, so the execution's verdict and its check run stay as they are.
 */
export const raiseUndeliveredRecords = (db: D1Like, now: number) =>
  Effect.gen(function* () {
    const { results } = yield* attempt("undelivered records", () =>
      db.prepare(UNDELIVERED_RECORDS).bind(RECORDS_BATCH).all(),
    );
    const raised: { readonly executionId: string | null; readonly result: RaiseResult }[] = [];
    for (const row of results as readonly UndeliveredRow[]) {
      const result = yield* raiseOnce(
        db,
        {
          name: RECORD_UNDELIVERED,
          severity: "page",
          dedupeKey: recordUndeliveredKey(row.id),
          detail: {
            execution_id: row.execution_id,
            kind: row.kind,
            state: row.state,
            reason: row.last_error,
          },
        },
        now,
      );
      raised.push({ executionId: row.execution_id, result });
    }
    return raised;
  });
