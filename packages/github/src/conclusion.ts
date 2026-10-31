// checkConclusion: the one mapping from verdict to check-run conclusion
// (specs/github-output.md § Conclusion mapping), verdictOf: the mapping from
// mameko's execution outcome to the verdict, and the check-run text the conclude
// update carries.
import {
  BUILT_IN_REASON_KINDS,
  CATEGORIES,
  type Category,
  type ExecutionOutcome,
} from "@fractalboxdev/mameko-coordinator";
import { Match, Schema } from "effect";

/**
 * mameko's closed failure categories. An acceptance-check rejection carries the reason kind the check returns,
 * `provenance: <check>`, in category `policy` (MAMEKO-LEASE-090).
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
 * The verdict of mameko's execution outcome, one case per tag (MAMEKO-RUN-047). A run's `skipped` carries only the
 * detail, so its reason is `not-applicable`.
 */
export const verdictOf = (
  outcome: ExecutionOutcome,
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

/** GitHub's limit on a check run's summary and text. */
export const OUTPUT_LIMIT = 65_535;

/** Cuts text to 65535 characters, the last line a truncation note that links the log viewer (FD-GH-017). */
export const truncate = (text: string, logUrl: string | undefined): string => {
  if (text.length <= OUTPUT_LIMIT) return text;
  const note = `\n\n… truncated; the full output is in the log viewer${logUrl === undefined ? "" : `: ${logUrl}`}`;
  return text.slice(0, OUTPUT_LIMIT - note.length) + note;
};

export const ConcludeDetails = Schema.Struct({
  class: Schema.String,
  executor_kind: Schema.NullOr(Schema.String),
  placement_reason: Schema.String,
  queue_age_ms: Schema.Number,
  reserved_micro_usd: Schema.Number,
  settled_micro_usd: Schema.Number,
  failing_step: Schema.optionalKey(Schema.String),
  error_tag: Schema.optionalKey(Schema.String),
  markdown: Schema.optionalKey(Schema.String),
});
export type ConcludeDetails = typeof ConcludeDetails.Type;

const usd = (micro: number) => `${(micro / 1_000_000).toFixed(6)} USD`;

/**
 * The concluded check run's summary: on a failure the failing step and error tag first, then the class, the
 * executor kind and placement reason, the queue age, the reserved and settled cost and the named reason, then
 * the run's own markdown (FD-GH-015, FD-GH-016).
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
  return [...lead, ...facts, ...(d.markdown === undefined ? [] : ["", d.markdown])].join("\n");
};
