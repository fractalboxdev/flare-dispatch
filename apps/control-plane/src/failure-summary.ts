// The failure summary source: the unbounded `incident/v1` pack of a failed execution, from the reason its record holds
// and the tail of its failing step's log in the `CACHE` bucket. The route bounds the pack (FD-IFC-042).
import {
  apiError,
  FailureSummaries,
  INCIDENT_CAPS,
  type ExecutionRecord,
  type IncidentV1,
} from "@fractalboxdev/flare-dispatch-api";
import {
  inStepOrder,
  listLogObjects,
  ndjsonToText,
  type Bucket,
} from "@fractalboxdev/flare-dispatch-cache";
import { Effect, Layer } from "effect";
import type { CacheEnv } from "./cache.ts";

/** The failing step of an execution: its step key and the tail of its log as plain text. */
export interface FailingStep {
  readonly stepKey: string;
  readonly logTail: string;
}

/**
 * The step that ran last at the epoch the record names (its accepted epoch, else its placement's epoch); a record that
 * names no epoch takes the highest epoch with logs. A failed execution stops at its failing step, so the last step that
 * wrote a log is the one that failed. An epoch that wrote no log has no failing step: the logs of an earlier, reclaimed
 * epoch belong to an attempt that did not fail. The step's segments are read from the newest back, until the tail reaches
 * the `incident/v1` log-tail cap.
 */
export const failingStep = async (
  bucket: Bucket,
  execution: ExecutionRecord,
): Promise<FailingStep | undefined> => {
  const objects = await listLogObjects(bucket, execution.execution_id);
  if (objects.length === 0) return undefined;
  const epoch =
    execution.accepted_epoch ?? execution.epoch ?? Math.max(...objects.map((o) => o.log.epoch));
  const atEpoch = objects.filter((o) => o.log.epoch === epoch);
  const last = inStepOrder(atEpoch).at(-1);
  if (last === undefined) return undefined;
  const segments = atEpoch
    .filter((o) => o.log.stepKey === last.log.stepKey)
    .sort(
      (a, b) =>
        a.uploaded - b.uploaded ||
        (a.log.stream < b.log.stream ? -1 : a.log.stream > b.log.stream ? 1 : 0) ||
        a.log.start - b.log.start,
    );
  const texts: string[] = [];
  let length = 0;
  for (let i = segments.length - 1; i >= 0 && length < INCIDENT_CAPS.logTail; i--) {
    const body = await bucket.get(segments[i]!.key);
    if (body === null) continue;
    const text = ndjsonToText(await body.text());
    texts.unshift(text);
    length += text.length + 1;
  }
  return { stepKey: last.log.stepKey, logTail: texts.join("\n") };
};

/**
 * The pack of a failed execution: one `run-step` failure whose conclusion is the record's reason, named by the run and
 * the failing step's key, with that step's log tail. An execution with no log names the run alone.
 */
export const incidentOf = (
  execution: ExecutionRecord,
  failing: FailingStep | undefined,
): IncidentV1 => ({
  contractVersion: "v1",
  incidentId: execution.execution_id,
  class: "ci",
  repo: execution.repository,
  ciFailures: [
    {
      kind: "run-step",
      name: failing === undefined ? execution.run : `${execution.run}/${failing.stepKey}`,
      conclusion: execution.reason ?? "failure",
      ...(failing === undefined || failing.logTail === "" ? {} : { logTail: failing.logTail }),
    },
  ],
});

/**
 * The failure summaries over the deploy's `CACHE` bucket. A deploy that binds no bucket stores no step log, so its
 * packs carry the reason alone; a bucket that cannot be read answers `unavailable`.
 */
export const failureSummaries = (env: CacheEnv): Layer.Layer<FailureSummaries> => {
  const bucket = env.CACHE;
  return Layer.succeed(FailureSummaries)({
    pack: (execution) =>
      Effect.gen(function* () {
        const failing =
          bucket === undefined
            ? undefined
            : yield* Effect.tryPromise({
                try: () => failingStep(bucket, execution),
                catch: () => apiError("unavailable", "the execution's step logs could not be read"),
              });
        return incidentOf(execution, failing);
      }),
  });
};
