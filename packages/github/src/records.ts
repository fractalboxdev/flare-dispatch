// The job and verdict records a deploying organization receives at `records.url` (specs/github-output.md § Job and
// verdict records): the `job.record` payload the profile's `jobRecordPayload` binding builds at each lease grant, and
// the `verdict.record` payload of each terminal execution. Each builder copies the fields its schema names and no
// other, so an execution's input, its logs and every secret stay out of a record (FD-GH-097).
import { Match, Schema } from "effect";
import type { Conclusion, Verdict } from "./conclusion.ts";

/** The `schema` value of a `job.record` payload. */
export const JOB_RECORD_SCHEMA = "job-record/v1";
/** The `schema` value of a `verdict.record` payload (FD-GH-095). */
export const VERDICT_RECORD_SCHEMA = "verdict-record/v1";

/** The `job.record` payload: one lease grant (FD-GH-093). */
export const JobRecordPayload = Schema.Struct({
  schema: Schema.Literal(JOB_RECORD_SCHEMA),
  execution_id: Schema.String,
  epoch: Schema.Number,
  run: Schema.String,
  /** `<owner>/<repo>`. */
  repository: Schema.String,
  commit_sha: Schema.String,
  class: Schema.String,
  executor_kind: Schema.String,
});
export type JobRecordPayload = typeof JobRecordPayload.Type;

/** The `verdict.record` payload: one terminal execution (FD-GH-095). */
export const VerdictRecordPayload = Schema.Struct({
  schema: Schema.Literal(VERDICT_RECORD_SCHEMA),
  execution_id: Schema.String,
  epoch: Schema.Number,
  run: Schema.String,
  /** `<owner>/<repo>`. */
  repository: Schema.String,
  commit_sha: Schema.String,
  ref: Schema.String,
  class: Schema.String,
  trigger: Schema.String,
  /** The terminal outcome: `success`, `failure`, `cancelled`, `skipped`, `deferred` or `expired`. */
  verdict: Schema.Literals(["success", "failure", "cancelled", "skipped", "deferred", "expired"]),
  /** The failure reason, the cancel cause or `<reason>: <detail>` of a skip; null for every other outcome. */
  reason: Schema.NullOr(Schema.String),
  /** The check run's GitHub conclusion; null while it has none, as for a `halt` outcome whose key is paused. */
  conclusion: Schema.NullOr(Schema.Literals(["success", "failure", "cancelled", "neutral"])),
  /** `flare-dispatch/<run>[:<checkLabel>]`; null for an execution that owns no check run. */
  check_name: Schema.NullOr(Schema.String),
});
export type VerdictRecordPayload = typeof VerdictRecordPayload.Type;

/** A record payload decodes only with exactly its schema's fields: an undeclared key fails it (FD-GH-097). */
export const decodeJobRecord = Schema.decodeUnknownExit(JobRecordPayload, {
  onExcessProperty: "error",
});
export const decodeVerdictRecord = Schema.decodeUnknownExit(VerdictRecordPayload, {
  onExcessProperty: "error",
});

/** What the `jobRecordPayload` binding reads of one lease grant: the execution row and the granted lease. */
export interface JobRecordRequest {
  readonly executionId: string;
  readonly epoch: number;
  readonly run: string;
  readonly repository: string;
  readonly commitSha: string;
  readonly class: string;
  readonly executorKind: string;
}

/**
 * The profile's `jobRecordPayload` binding: the execution id, epoch, run, repository, commit SHA, class and executor
 * kind of one lease grant (FD-GH-093), and nothing else of the request (FD-GH-097).
 */
export const jobRecordPayload = (r: JobRecordRequest): JobRecordPayload => ({
  schema: JOB_RECORD_SCHEMA,
  execution_id: r.executionId,
  epoch: r.epoch,
  run: r.run,
  repository: r.repository,
  commit_sha: r.commitSha,
  class: r.class,
  executor_kind: r.executorKind,
});

/** What a `verdict.record` reads of one terminal execution and its check run. */
export interface VerdictRecordRequest {
  readonly executionId: string;
  readonly epoch: number;
  readonly run: string;
  readonly repository: string;
  readonly commitSha: string;
  /** The git ref the execution verifies. */
  readonly ref: string;
  readonly class: string;
  /** How the request reached the control plane, as admission recorded it. */
  readonly trigger: string;
  readonly verdict: Verdict;
  /** The conclusion the check run carries; null while it has none. */
  readonly conclusion: Conclusion | null;
  /** The check run the execution owns; null when it owns none. */
  readonly checkName: string | null;
}

/** The reason a record states for an outcome: the failure reason, the cancel cause, or a skip's reason and detail. */
const reasonOf = (verdict: Verdict): string | null =>
  Match.value(verdict).pipe(
    Match.tag("failure", ({ reason }) => reason),
    Match.tag("cancelled", ({ cause }) => cause),
    Match.tag("skipped", ({ reason, detail }) => `${reason}: ${detail}`),
    Match.orElse(() => null),
  );

/** The outcome's name as a record states it. */
const outcomeOf = (verdict: Verdict): VerdictRecordPayload["verdict"] =>
  Match.value(verdict).pipe(
    Match.tag("success", () => "success" as const),
    Match.tag("failure", () => "failure" as const),
    Match.tag("cancelled", () => "cancelled" as const),
    Match.tag("skipped", () => "skipped" as const),
    Match.tag("deferred", () => "deferred" as const),
    Match.tag("expired", () => "expired" as const),
    Match.exhaustive,
  );

/**
 * The `verdict.record` payload of one terminal execution: the schema `verdict-record/v1`, execution id, epoch, run,
 * repository, commit SHA, ref, class, trigger, verdict, reason, conclusion and check name (FD-GH-095), and nothing
 * else of the request (FD-GH-097).
 */
export const verdictRecordPayload = (r: VerdictRecordRequest): VerdictRecordPayload => ({
  schema: VERDICT_RECORD_SCHEMA,
  execution_id: r.executionId,
  epoch: r.epoch,
  run: r.run,
  repository: r.repository,
  commit_sha: r.commitSha,
  ref: r.ref,
  class: r.class,
  trigger: r.trigger,
  verdict: outcomeOf(r.verdict),
  reason: reasonOf(r.verdict),
  conclusion: r.conclusion,
  check_name: r.checkName,
});
