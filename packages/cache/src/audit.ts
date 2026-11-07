// The verdict audit (specs/provenance.md § Verdict audit). Warm state on a device can hide a flaky test; a sample of
// device verdicts of gate recipes is re-run cold on a cloud executor as an ops run, and a disagreement is recorded and
// alarmed without touching the conclusion already posted.
import { AlarmPort } from "@fractalboxdev/mameko-ports";
import { Effect } from "effect";

/** The gating runs (profile FD-PROF-013). */
export const GATE_RECIPES: readonly string[] = ["check", "oxlint", "offload-test"];
export const DEFAULT_AUDIT_RATE = 0.05;

export const VERDICT_AUDIT_SCHEMA = `create table if not exists verdict_audits (
  device_execution_id text not null,
  device_executor_id text not null,
  audit_execution_id text not null,
  audit_executor_id text not null,
  device_verdict text not null,
  audit_verdict text not null,
  recorded_at integer not null,
  primary key (device_execution_id, audit_execution_id)
)`;

export interface ConcludedExecution {
  readonly executionId: string;
  readonly executorId: string;
  readonly executorKind: string;
  readonly run: string;
  readonly commit: string;
  readonly inputs: unknown;
  readonly verdict: string;
}

/** The ops-run request the control plane admits for an audit; `ops_run` is set by the control plane only. */
export interface AuditRequest {
  readonly run: string;
  readonly commit: string;
  readonly inputs: unknown;
  readonly ops_run: true;
  readonly constraints: readonly ["cloud-only"];
  readonly audits: string;
}

/**
 * FD-PROV-069: a device execution of a gate recipe is selected with probability `auditRate` (default 5%), and the
 * selected one yields an ops run of the same run, commit and inputs pinned to the cloud, charged to the ops reserve.
 */
export const auditRequestFor = (
  concluded: ConcludedExecution,
  options: { readonly auditRate?: number; readonly random?: () => number; readonly gates?: readonly string[] } = {},
): AuditRequest | null => {
  if (concluded.executorKind !== "device") return null;
  if (!(options.gates ?? GATE_RECIPES).includes(concluded.run)) return null;
  if ((options.random ?? Math.random)() >= (options.auditRate ?? DEFAULT_AUDIT_RATE)) return null;
  return {
    run: concluded.run,
    commit: concluded.commit,
    inputs: concluded.inputs,
    ops_run: true,
    constraints: ["cloud-only"],
    audits: concluded.executionId,
  };
};

/**
 * FD-PROV-070: when the audit verdict differs from the device verdict, writes a `verdict_audits` row naming both
 * executions and executors and raises a notify alarm. It reads and writes nothing of the posted conclusion.
 */
export const recordAuditVerdict = (
  db: D1Database,
  device: ConcludedExecution,
  audit: ConcludedExecution,
  nowMs: number,
) =>
  Effect.gen(function* () {
    if (device.verdict === audit.verdict) return "agree" as const;
    yield* Effect.promise(() =>
      db
        .prepare(
          `insert into verdict_audits (device_execution_id, device_executor_id, audit_execution_id, audit_executor_id,
             device_verdict, audit_verdict, recorded_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           on conflict do nothing`,
        )
        .bind(device.executionId, device.executorId, audit.executionId, audit.executorId, device.verdict, audit.verdict, nowMs)
        .run(),
    );
    const alarms = yield* AlarmPort;
    yield* alarms
      .deliver({
        name: "verdict-audit-disagreement",
        severity: "notify",
        dedupeKey: `verdict-audit:${device.executionId}`,
        state: "raised",
        detail: {
          run: device.run,
          commit: device.commit,
          device: { execution_id: device.executionId, executor_id: device.executorId, verdict: device.verdict },
          audit: { execution_id: audit.executionId, executor_id: audit.executorId, verdict: audit.verdict },
        },
      })
      .pipe(Effect.catchTag("AlarmDeliveryFailed", (e) => Effect.logWarning("verdict audit alarm undelivered", e.reason)));
    return "disagree" as const;
  });
