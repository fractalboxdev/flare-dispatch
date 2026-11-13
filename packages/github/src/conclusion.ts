// checkConclusion: the one mapping from verdict to check-run conclusion
// (specs/github-output.md § Conclusion mapping), verdictOf: the mapping from
// mameko's execution outcome to the verdict, the `neutral` invariant, and the
// check-run text the conclude update carries.
import {
  BUILT_IN_REASON_KINDS,
  CATEGORIES,
  type Category,
  type ExecutionOutcome,
} from "@fractalboxdev/mameko-coordinator";
import { AlarmPort } from "@fractalboxdev/mameko-ports";
import { Effect, Match, Schema } from "effect";

/**
 * mameko's closed failure categories. An acceptance-check rejection carries the reason kind the check returns,
 * `provenance: <check>`, in category `policy` (MAMEKO-LEASE-093).
 */
export const FailureCategory = Schema.Literals(CATEGORIES);

/** The not-applicable details that conclude `neutral` (specs/run-model.md). */
export const NOT_APPLICABLE_DETAILS: readonly string[] = [
  "draft-pr",
  "author-excluded",
  "path-filter",
  "not-configured",
  "nothing-to-lint",
  "every-job-skipped",
  "empty-range",
];

export const Verdict = Schema.Union([
  Schema.TaggedStruct("success", {}),
  Schema.TaggedStruct("failure", { category: FailureCategory, reason: Schema.String }),
  /** mameko's `cause` is open: a run reports its own, and a result without one reports `cancelled`. */
  Schema.TaggedStruct("cancelled", { cause: Schema.String }),
  Schema.TaggedStruct("skipped", { reason: Schema.String, detail: Schema.String }),
  /** A `batch` execution that opened a check run and ended `deferred`. */
  Schema.TaggedStruct("deferred", {}),
  /** mameko's terminal outcome `expired`; no FlareDispatch class declares it. */
  Schema.TaggedStruct("expired", {}),
]);
export type Verdict = typeof Verdict.Type;

export type Conclusion = "success" | "failure" | "cancelled" | "neutral";

/** The only function that produces a conclusion; it emits `success`, `failure`, `cancelled` and `neutral`. */
export const checkConclusion = (
  verdict: Verdict,
): { readonly conclusion: Conclusion; readonly title: string } =>
  Match.value(verdict).pipe(
    Match.tag("success", () => ({ conclusion: "success" as const, title: "success" })),
    Match.tag("failure", ({ category, reason }) => ({
      conclusion: "failure" as const,
      title: category === "unrecorded" ? "internal: terminal write not recorded" : reason,
    })),
    Match.tag("cancelled", ({ cause }) => ({ conclusion: "cancelled" as const, title: cause })),
    Match.tag("skipped", ({ reason, detail }) =>
      reason === "not-applicable" && NOT_APPLICABLE_DETAILS.includes(detail)
        ? { conclusion: "neutral" as const, title: `not applicable: ${detail}` }
        : { conclusion: "failure" as const, title: "internal: invalid skip reason" },
    ),
    Match.tag("deferred", () => ({ conclusion: "failure" as const, title: "capacity: deferred" })),
    Match.tag("expired", () => ({ conclusion: "failure" as const, title: "deadline: expired" })),
    Match.exhaustive,
  );

/** A failure reason's category: `<kind>[: <detail>]`, the kind built in or declared in `reason_kinds`. */
const categoryOf = (reason: string, declared: Readonly<Record<string, Category>>): Category => {
  const kind = reason.split(":")[0]?.trim() ?? "";
  // A kind of the run catalogue outside both tables concludes the same: the category selects only the
  // `unrecorded` title.
  return BUILT_IN_REASON_KINDS[kind] ?? declared[kind] ?? "infra";
};

/**
 * mameko's execution outcome as its terminal write records it: the outcome row's payload is `{ outcome }`, and a
 * stored outcome may omit the epoch (mameko `store-sqlite` `applyOutbox`). Only the fields a verdict reads are kept.
 */
export const RecordedOutcome = Schema.Union([
  Schema.TaggedStruct("Success", {}),
  Schema.TaggedStruct("Failure", { reason: Schema.String }),
  Schema.TaggedStruct("Cancelled", { cause: Schema.String }),
  Schema.TaggedStruct("Skipped", { detail: Schema.String }),
  Schema.TaggedStruct("Deferred", {}),
  Schema.TaggedStruct("Expired", {}),
]);
export type RecordedOutcome = typeof RecordedOutcome.Type;

/** The payload of the outcome row mameko inserts with an execution's terminal write. */
export const OutcomePayload = Schema.Struct({ outcome: RecordedOutcome });

/**
 * The verdict of mameko's execution outcome, one case per tag (MAMEKO-RUN-051). A run's `skipped` carries only the
 * detail, so its reason is `not-applicable`.
 */
export const verdictOf = (
  outcome: ExecutionOutcome | RecordedOutcome,
  declared: Readonly<Record<string, Category>> = {},
): Verdict =>
  Match.value(outcome).pipe(
    Match.tag("Success", (): Verdict => ({ _tag: "success" })),
    Match.tag("Failure", ({ reason }): Verdict => ({
      _tag: "failure",
      category: categoryOf(reason, declared),
      reason,
    })),
    Match.tag("Cancelled", ({ cause }): Verdict => ({ _tag: "cancelled", cause })),
    Match.tag("Skipped", ({ detail }): Verdict => ({
      _tag: "skipped",
      reason: "not-applicable",
      detail,
    })),
    Match.tag("Deferred", (): Verdict => ({ _tag: "deferred" })),
    Match.tag("Expired", (): Verdict => ({ _tag: "expired" })),
    Match.exhaustive,
  );

/** The cause mameko's parent-ended cascade records on each child a parent's end cancels (MAMEKO-RUN-088). */
export const PARENT_ENDED = "parent-ended";

/** The verdict a child concludes with when its parent reaches its outcome first (FD-GH-020). */
export const PARENT_CLOSED: Verdict = {
  _tag: "failure",
  category: "infra",
  reason: "parent closed before this part settled",
};

/**
 * The verdict of an outcome row: `verdictOf(outcome)`, except that a child the parent's end cancelled settled no verdict
 * of its own and concludes `failure` "parent closed before this part settled" (FD-GH-020).
 */
export const concludedVerdictOf = (
  outcome: RecordedOutcome,
  declared: Readonly<Record<string, Category>> = {},
): Verdict =>
  Match.value(outcome).pipe(
    Match.tag("Cancelled", ({ cause }) =>
      cause === PARENT_ENDED ? PARENT_CLOSED : verdictOf(outcome, declared),
    ),
    Match.orElse(() => verdictOf(outcome, declared)),
  );

/**
 * The verdict a conclusion states for an execution's recorded outcome, as `concludedVerdictOf` states it for the outcome
 * row: the recorded verdict, except that a child the parent-ended cascade cancelled concludes `failure` "parent closed
 * before this part settled" (FD-GH-020).
 */
export const concludedRecordedVerdict = (recorded: Verdict): Verdict =>
  Match.value(recorded).pipe(
    Match.tag("cancelled", ({ cause }) => (cause === PARENT_ENDED ? PARENT_CLOSED : recorded)),
    Match.orElse(() => recorded),
  );

/**
 * The verdict an execution row records in its `status` and `reason` columns, which mameko's terminal write sets with the
 * outcome row; null while the execution is not terminal. A skip's reason reads `<reason>: <detail>`.
 */
export const recordedVerdict = (status: string, reason: string | null): Verdict | null =>
  Match.value(status).pipe(
    Match.when("success", (): Verdict => ({ _tag: "success" })),
    Match.when("failure", (): Verdict => ({
      _tag: "failure",
      category: categoryOf(reason ?? "", {}),
      reason: reason ?? "",
    })),
    Match.when("cancelled", (): Verdict => ({ _tag: "cancelled", cause: reason ?? "cancelled" })),
    Match.when("skipped", (): Verdict => {
      const text = reason ?? "";
      const colon = text.indexOf(":");
      return colon === -1
        ? { _tag: "skipped", reason: text, detail: "" }
        : {
            _tag: "skipped",
            reason: text.slice(0, colon).trim(),
            detail: text.slice(colon + 1).trim(),
          };
    }),
    Match.when("deferred", (): Verdict => ({ _tag: "deferred" })),
    Match.when("expired", (): Verdict => ({ _tag: "expired" })),
    Match.orElse(() => null),
  );

/** Whether a conclusion agrees with the recorded outcome: `neutral` only on a listed `not-applicable` skip. */
export const neutralHolds = (conclusion: string | null, recorded: Verdict) =>
  conclusion !== "neutral" ||
  Match.value(recorded).pipe(
    Match.tag(
      "skipped",
      ({ reason, detail }) =>
        reason === "not-applicable" && NOT_APPLICABLE_DETAILS.includes(detail),
    ),
    Match.orElse(() => false),
  );

/** Raises the `neutral-invariant` page alarm when a check run concluded `neutral` on any other outcome (FD-GH-031). */
export const checkNeutralInvariant = (
  executionId: string,
  scopeId: string,
  conclusion: string | null,
  recorded: Verdict,
) =>
  neutralHolds(conclusion, recorded)
    ? Effect.void
    : Effect.flatMap(
        AlarmPort.use((a) => Effect.succeed(a)),
        (alarms) =>
          alarms
            .deliver({
              name: "neutral-invariant",
              severity: "page",
              dedupeKey: `neutral-invariant:${executionId}`,
              state: "raised",
              detail: {
                executionId,
                scopeId,
                recorded,
                mapped: checkConclusion(recorded).conclusion,
              },
            })
            .pipe(
              Effect.catchTag("AlarmDeliveryFailed", (e) =>
                Effect.logWarning("alarm not delivered", e.reason),
              ),
            ),
      );

/** GitHub's limit on a check run's summary and text. */
export const OUTPUT_LIMIT = 65_535;

/** Cuts text to 65535 characters, the last line a truncation note that links the log viewer (FD-GH-017). */
export const truncate = (text: string, logUrl: string | undefined): string => {
  if (text.length <= OUTPUT_LIMIT) return text;
  const note = `\n\n… truncated; the full output is in the log viewer${logUrl === undefined ? "" : `: ${logUrl}`}`;
  return text.slice(0, OUTPUT_LIMIT - note.length) + note;
};

export const QuarantinedFailure = Schema.Struct({
  test: Schema.String,
  path: Schema.String,
  line: Schema.Number,
  message: Schema.String,
});

/**
 * One provenance statement of the execution as the check summary links it (FD-PROV-042): the statement's lookup, its
 * inclusion proof in the log that holds it, and a lookup by each `sha256` subject digest. A statement whose log append
 * has not succeeded is `log-pending` and has no inclusion proof yet (FD-PROV-041).
 */
export const StatementLink = Schema.Struct({
  envelope_digest: Schema.String,
  status: Schema.Literals(["logged", "log-pending"]),
  statement_url: Schema.String,
  inclusion_proof_url: Schema.NullOr(Schema.String),
  subjects: Schema.Array(Schema.Struct({ digest: Schema.String, url: Schema.String })),
});
export type StatementLink = typeof StatementLink.Type;

export const ConcludeDetails = Schema.Struct({
  class: Schema.String,
  executor_kind: Schema.NullOr(Schema.String),
  /** The executor that holds the accepted lease, or else the latest one; the log pointer names it (FD-GH-019). */
  executor_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  placement_reason: Schema.String,
  queue_age_ms: Schema.Number,
  reserved_micro_usd: Schema.Number,
  settled_micro_usd: Schema.Number,
  failing_step: Schema.optionalKey(Schema.String),
  error_tag: Schema.optionalKey(Schema.String),
  markdown: Schema.optionalKey(Schema.String),
  /** Test failures a gate run reports as quarantined (FD-GH-077). */
  quarantined: Schema.optionalKey(Schema.Array(QuarantinedFailure)),
  /** The execution's provenance statements (FD-PROV-042). */
  provenance: Schema.optionalKey(Schema.Array(StatementLink)),
});
export type ConcludeDetails = typeof ConcludeDetails.Type;

/** Each quarantined failure as a `warning` annotation on the check run (FD-GH-077). */
export const quarantineAnnotations = (d: ConcludeDetails) =>
  (d.quarantined ?? []).map((q) => ({
    path: q.path,
    start_line: q.line,
    end_line: q.line,
    annotation_level: "warning" as const,
    title: `quarantined: ${q.test}`,
    message: q.message,
  }));

const usd = (micro: number) => `${(micro / 1_000_000).toFixed(6)} USD`;

/**
 * One line per provenance statement: a logged statement links the statement, its inclusion proof and each subject
 * digest (FD-PROV-042); a statement whose append has not succeeded shows `log-pending` (FD-PROV-041).
 */
export const provenanceLines = (statements: readonly StatementLink[]): readonly string[] =>
  statements.map((s) => {
    const statement = `[\`${s.envelope_digest}\`](${s.statement_url})`;
    if (s.status === "log-pending") return `- Statement ${statement}: log-pending`;
    const proof =
      s.inclusion_proof_url === null ? "" : `, [inclusion proof](${s.inclusion_proof_url})`;
    const subjects =
      s.subjects.length === 0
        ? ""
        : `; subjects ${s.subjects.map((d) => `[\`${d.digest}\`](${d.url})`).join(", ")}`;
    return `- Statement ${statement}: logged${proof}${subjects}`;
  });

/**
 * The concluded check run's summary: on a failure the failing step and error tag first, then the class, the
 * executor kind and placement reason, the queue age, the reserved and settled cost and the named reason, then
 * each quarantined failure, then the execution's provenance statements, then the run's own markdown (FD-GH-015,
 * FD-GH-016, FD-GH-077, FD-PROV-042).
 */
export const concludeSummary = (verdict: Verdict, d: ConcludeDetails): string => {
  const { conclusion, title } = checkConclusion(verdict);
  const lead =
    conclusion === "failure" && d.failing_step !== undefined
      ? [
          `**Failed step:** \`${d.failing_step}\`${d.error_tag === undefined ? "" : ` (${d.error_tag})`}`,
          "",
        ]
      : [];
  const facts = [
    `- Class: ${d.class}`,
    `- Executor: ${d.executor_kind ?? "none"} (${d.placement_reason})`,
    `- Queue age: ${Math.round(d.queue_age_ms / 1000)} s`,
    `- Cost: reserved ${usd(d.reserved_micro_usd)}, settled ${usd(d.settled_micro_usd)}`,
    ...(conclusion === "failure" || conclusion === "cancelled" ? [`- Reason: ${title}`] : []),
  ];
  const quarantined = (d.quarantined ?? []).map(
    (q) => `- \`${q.test}\` (${q.path}:${q.line}): ${q.message}`,
  );
  const provenance = provenanceLines(d.provenance ?? []);
  return [
    ...lead,
    ...facts,
    ...(quarantined.length === 0 ? [] : ["", "**Quarantined failures:**", ...quarantined]),
    ...(provenance.length === 0 ? [] : ["", "**Provenance:**", ...provenance]),
    ...(d.markdown === undefined ? [] : ["", d.markdown]),
  ].join("\n");
};

/**
 * The concluded check run's summary for a `confidential-compute` repository (FD-GH-019): the outcome, the conclusion
 * reason, the class, the executor id and the log pointer. No failing step, run-authored markdown, quarantined test,
 * placement or cost appears, since each can carry source, a log line or model output.
 */
export const confidentialSummary = (
  verdict: Verdict,
  d: ConcludeDetails,
  logUrl: string | undefined,
): string => {
  const { conclusion, title } = checkConclusion(verdict);
  const executor = d.executor_id ?? "none";
  return [
    `- Outcome: ${conclusion}`,
    `- Reason: ${title}`,
    `- Class: ${d.class}`,
    `- Executor: ${executor}`,
    `- Logs: kept on executor ${executor}${logUrl === undefined ? "" : `; pointer: ${logUrl}`}`,
  ].join("\n");
};
