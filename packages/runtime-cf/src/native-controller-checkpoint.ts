import { Effect, Match, Schema } from "effect";
import {
  NativeAdmissionTime, NativeApiEvidence, NativePendingStatus, NativeReceiptRefused, NativeTerminalConclusion,
} from "@fractalboxdev/flare-dispatch-core";
import { advanceNativeController } from "./native-controller";
import { nativeResultKey } from "./native-result-r2";

const Clock = { admittedAt: NativeAdmissionTime };
const Run = { runId: NativeApiEvidence.fields.runId, runAttempt: NativeApiEvidence.fields.runAttempt };
/** Cloudflare's non-stream step result ceiling, measured as serialized UTF8 bytes. */
export const NATIVE_CONTROLLER_CHECKPOINT_MAX_BYTES = 2 ** 20;

/** Checkpoints contain lifecycle metadata; credentials and verified file bodies remain outside Workflow state. */
export const NativeControllerCheckpoint = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("WaitingForRun"), ...Clock }),
  Schema.Struct({ _tag: Schema.Literal("Running"), ...Clock, ...Run, status: NativePendingStatus }),
  Schema.Struct({ _tag: Schema.Literal("Failed"), ...Clock, ...Run, conclusion: NativeTerminalConclusion }),
  Schema.Struct({ _tag: Schema.Literal("Published"), ...Clock, ...Run, manifestKey: Schema.String.pipe(Schema.nonEmptyString()) }),
).pipe(Schema.filter((checkpoint) => new TextEncoder().encode(JSON.stringify(checkpoint)).byteLength
  <= NATIVE_CONTROLLER_CHECKPOINT_MAX_BYTES));
export type NativeControllerCheckpoint = typeof NativeControllerCheckpoint.Type;

/** Only the authenticated controller produces a published checkpoint; projection confers no result-reader authority. */
export const advanceNativeControllerCheckpoint = (
  options: Parameters<typeof advanceNativeController>[0], rawRequest: unknown,
) => Effect.gen(function* () {
  const outcome = yield* advanceNativeController(options, rawRequest);
  const checkpoint = Match.value(outcome).pipe(
    Match.tag("WaitingForRun", ({ admittedAt }) => ({ _tag: "WaitingForRun" as const, admittedAt })),
    Match.tag("Running", ({ admittedAt, runId, runAttempt, status }) => ({ _tag: "Running" as const, admittedAt, runId, runAttempt, status })),
    Match.tag("Failed", ({ admittedAt, runId, runAttempt, conclusion }) => ({ _tag: "Failed" as const, admittedAt, runId, runAttempt, conclusion })),
    Match.tag("Published", ({ admittedAt, result }) => ({
      _tag: "Published" as const, admittedAt, runId: Number(result.receipt.run_id), runAttempt: Number(result.receipt.run_attempt),
      manifestKey: nativeResultKey(result.request),
    })),
    Match.exhaustive,
  );
  return yield* Schema.decodeUnknown(NativeControllerCheckpoint, { onExcessProperty: "error" })(checkpoint).pipe(
    Effect.mapError(() => new NativeReceiptRefused({ reason: "native controller checkpoint invalid" })),
  );
});
