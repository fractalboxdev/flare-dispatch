// The job and verdict records a deploying organization receives at `records.url` (specs/github-output.md § Job and
// verdict records): the `job.record` payload the profile's `jobRecordPayload` binding builds at each lease grant, and
// the `verdict.record` payload of each terminal execution. Each builder copies the fields its schema names and no
// other, so an execution's input, its logs and every secret stay out of a record (FD-GH-097). Where a run reports scan
// results or findings, under the `report` member of its `check.summary` or `check.annotations` payload, the
// `verdict.record` also holds them (FD-GH-096).
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

/** The most findings one `verdict.record` holds (FD-GH-096). */
export const RECORD_FINDINGS_MAX = 200;

/** What one scanner reports: `clean`, `finding`, `tool-error` or `nothing-in-scope`. */
export const ReportedScanResult = Schema.Literals([
  "clean",
  "finding",
  "tool-error",
  "nothing-in-scope",
]);

/** One finding a run reports: its identity, where it starts and ends, and its level. */
export const ReportedFinding = Schema.Struct({
  /** The scanner's rule, audit or advisory id, or `pr-review/<reviewer>`. */
  ruleId: Schema.NonEmptyString,
  /** The lowercase hex SHA-256 that identifies the finding across runs. */
  fingerprint: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  /** The path relative to the checkout. */
  path: Schema.String,
  startLine: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  endLine: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  level: Schema.Literals(["notice", "warning", "failure"]),
});
export type ReportedFinding = typeof ReportedFinding.Type;

/** What a scan run reports of its scan: the bundle, the advisory snapshots it read and each scanner. */
export const ReportedScan = Schema.Struct({
  /** `sha256:<hex>` of the scan bundle the scan verified. */
  bundle_digest: Schema.String,
  /** Each advisory snapshot the scan read, as `sha256:<hex>`. */
  advisory_snapshots: Schema.Array(
    Schema.Struct({ ecosystem: Schema.String, digest: Schema.String }),
  ),
  /** Each scanner's name, its version in the image, and its scan result; null where the scan stopped before it ran. */
  scanners: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      version: Schema.String,
      result: Schema.NullOr(ReportedScanResult),
    }),
  ),
});
export type ReportedScan = typeof ReportedScan.Type;

/**
 * The `report` member of a run's `check.summary` or `check.annotations` payload: its scan, where it ran one, and its
 * findings, where it reports any. A run reports at most 200 findings and sets `findingsTruncated` where it found
 * findings it does not list.
 */
export const RunReport = Schema.Struct({
  scan: Schema.optionalKey(ReportedScan),
  findings: Schema.optionalKey(Schema.Array(ReportedFinding)),
  findingsTruncated: Schema.optionalKey(Schema.Boolean),
});
export type RunReport = typeof RunReport.Type;

/** A run-emitted payload's `report` member, read where it decodes; any other member of the payload is not read. */
export const decodeRunReport = Schema.decodeUnknownOption(Schema.Struct({ report: RunReport }));

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
  /** The scan the run reports; absent where it reports none (FD-GH-096). */
  scan: Schema.optionalKey(ReportedScan),
  /** At most 200 of the findings the run reports; absent with `findingsTruncated` where it reports none. */
  findings: Schema.optionalKey(
    Schema.Array(ReportedFinding).check(Schema.isMaxLength(RECORD_FINDINGS_MAX)),
  ),
  /** True where the run found findings `findings` does not hold. */
  findingsTruncated: Schema.optionalKey(Schema.Boolean),
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
  /** The `report` member of each of the execution's `check.summary` rows, then each of its `check.annotations` rows. */
  readonly reports?: readonly RunReport[];
}

/** The reason a record states for an outcome: the failure reason, the cancel cause, or a skip's reason and detail. */
const reasonOf = (verdict: Verdict): string | null =>
  Match.value(verdict).pipe(
    Match.tag("failure", ({ reason }) => reason),
    Match.tag("cancelled", ({ cause }) => cause),
    Match.tag("skipped", ({ reason, detail }) => (detail === "" ? reason : `${reason}: ${detail}`)),
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
 * repository, commit SHA, ref, class, trigger, verdict, reason, conclusion and check name (FD-GH-095), the scan and
 * findings the run reports (FD-GH-096), and nothing else of the request (FD-GH-097).
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
  ...recordedReport(r.reports ?? []),
});

/**
 * What a `verdict.record` holds of the run's reports (FD-GH-096): the first reported scan, and the findings of every
 * report in order, cut to 200, with `findingsTruncated` true where the cut drops one or a report says it lists fewer
 * than it found. A run that reports no findings yields neither member, so an absent list is never read as none found.
 */
export const recordedReport = (
  reports: readonly RunReport[],
): Pick<VerdictRecordPayload, "scan" | "findings" | "findingsTruncated"> => {
  const scan = reports.find((r) => r.scan !== undefined)?.scan;
  const reporting = reports.filter(
    (r) => r.findings !== undefined || r.findingsTruncated !== undefined,
  );
  const findings = reporting.flatMap((r) => r.findings ?? []);
  return {
    ...(scan === undefined ? {} : { scan: copyScan(scan) }),
    ...(reporting.length === 0
      ? {}
      : {
          findings: findings.slice(0, RECORD_FINDINGS_MAX).map(copyFinding),
          findingsTruncated:
            findings.length > RECORD_FINDINGS_MAX ||
            reporting.some((r) => r.findingsTruncated === true),
        }),
  };
};

/** The scan's declared fields and no other. */
const copyScan = (s: ReportedScan): ReportedScan => ({
  bundle_digest: s.bundle_digest,
  advisory_snapshots: s.advisory_snapshots.map((a) => ({
    ecosystem: a.ecosystem,
    digest: a.digest,
  })),
  scanners: s.scanners.map((x) => ({ name: x.name, version: x.version, result: x.result })),
});

/** The finding's declared fields and no other: a reviewer's title and message stay out of a record. */
const copyFinding = (f: ReportedFinding): ReportedFinding => ({
  ruleId: f.ruleId,
  fingerprint: f.fingerprint,
  path: f.path,
  startLine: f.startLine,
  endLine: f.endLine,
  level: f.level,
});
