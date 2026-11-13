// What the `check.conclude` applier reads beside the outcome row. mameko's terminal write inserts that row with the
// payload `{ outcome }` alone (mameko `store-sqlite` `applyOutbox`), so the check run's name, head SHA, attempt, the
// execution's class, placement and cost, and its log link come from the control plane's own records of the execution
// (specs/github-output.md § Check-run lifecycle).
import { Context, Schema, type Effect } from "effect";
import { recordedVerdict, type ConcludeDetails, type Verdict } from "./conclusion.ts";

/** The placement row's claim record (mameko specs/placement-leases.md § Claim record). */
export interface PlacementFacts {
  readonly admittedAt: number | null;
  readonly claimLatencyMs: number | null;
  readonly leasedKind: string | null;
  readonly acceptedKind: string | null;
  /** The executor of the latest lease; null before the first grant. */
  readonly executorId: string | null;
  /** Whether the first grant went to a cloud kind; null before the first grant. */
  readonly cloudWon: boolean | null;
}

/** The execution's reservation row. */
export interface ReservationFacts {
  readonly holdMicroUsd: number;
  readonly state: string;
  readonly meteredMicroUsd: number | null;
}

/** One execution as the control plane records it: the intake record beside mameko's execution, placement and reservation. */
export interface ExecutionRecordFacts {
  /** The check run's name, `flare-dispatch/<run>[:<checkLabel>]`, the same for every attempt of the family (FD-GH-006). */
  readonly name: string;
  readonly headSha: string;
  readonly attempt: number;
  readonly className: string;
  /** mameko's execution status and reason. */
  readonly status: string;
  readonly reason: string | null;
  readonly enqueuedAt: number;
  readonly finishedAt: number | null;
  /** Null when admission concluded the execution without a placement row. */
  readonly placement: PlacementFacts | null;
  /** Null when no reservation was held. */
  readonly reservation: ReservationFacts | null;
}

/** What the conclusion of one execution carries beside its outcome. */
export interface ConclusionFacts {
  readonly name: string;
  readonly headSha: string;
  readonly attempt: number;
  /** The log viewer URL with its link token (FD-GH-013); absent when the deploy names no public origin. */
  readonly detailsUrl: string | undefined;
  readonly details: ConcludeDetails;
  /** The outcome the execution row records; null while it records none. */
  readonly recorded: Verdict | null;
}

/** The placement reason the summary states: which entry won the first grant, or why there was none. */
export const placementReason = (placement: PlacementFacts | null): string => {
  if (placement === null) return "not placed";
  if (placement.cloudWon === null) return "no lease granted";
  return placement.cloudWon ? "cloud entry won" : "device entry won";
};

/**
 * The summary facts of one execution (FD-GH-015): the class, the executor kind of the accepted lease or else the latest
 * one, the placement reason, the queue age (the claim latency, or the whole wait when no lease was granted), the hold
 * reserved and the cost settled.
 */
export const conclusionFactsOf = (
  record: ExecutionRecordFacts,
  detailsUrl: string | undefined,
): ConclusionFacts => {
  const p = record.placement;
  const waitedFrom = p?.admittedAt ?? record.enqueuedAt;
  const queueAge =
    p?.claimLatencyMs ?? Math.max(0, (record.finishedAt ?? record.enqueuedAt) - waitedFrom);
  const r = record.reservation;
  return {
    name: record.name,
    headSha: record.headSha,
    attempt: record.attempt,
    detailsUrl,
    details: {
      class: record.className,
      executor_kind: p?.acceptedKind ?? p?.leasedKind ?? null,
      executor_id: p?.executorId ?? null,
      placement_reason: placementReason(p),
      queue_age_ms: queueAge,
      reserved_micro_usd: r?.holdMicroUsd ?? 0,
      settled_micro_usd: r?.state === "settled" ? (r.meteredMicroUsd ?? 0) : 0,
    },
    recorded: recordedVerdict(record.status, record.reason),
  };
};

/** The control plane's records could not be read; the row is tried again. */
export class ConcludeFactsUnavailable extends Schema.TaggedError<ConcludeFactsUnavailable>()(
  "ConcludeFactsUnavailable",
  { message: Schema.String },
) {}

/**
 * What the check-run applier reads from the control plane's records: the facts of an execution's conclusion, null when
 * the control plane holds no record of the execution, and whether a repository's confidentiality mode is
 * `confidential-compute`, which limits every check run's output (FD-GH-019).
 */
export class ConcludeFacts extends Context.Service<
  ConcludeFacts,
  {
    readonly of: (
      executionId: string,
    ) => Effect.Effect<ConclusionFacts | null, ConcludeFactsUnavailable>;
    readonly confidentialCompute: (repo: string) => boolean;
  }
>()("@fractalboxdev/flare-dispatch-github/ConcludeFacts") {}
