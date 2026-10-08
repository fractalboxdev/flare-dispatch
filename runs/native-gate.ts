import { Effect, Schema } from "effect";
import { defineRun, io, nativeExecution, NativeGateInput, NativeReceiptRefused, step } from "@fractalboxdev/flare-dispatch-core";

const EXECUTION_SECONDS = 4 * 3600;
const FINALIZATION_SECONDS = 600;
const ADMISSION_SECONDS = 90 * 60;
export const NATIVE_GATE_JOIN_MILLISECONDS = (EXECUTION_SECONDS + FINALIZATION_SECONDS + ADMISSION_SECONDS + 600) * 1000;

export const NativeGateRunInput = Schema.Struct({
  repo: Schema.String, sha: NativeGateInput.fields.head, baseSha: NativeGateInput.fields.base,
  target: NativeGateInput.fields.target, checkLabel: Schema.Literal("windows.x86_64-msvc", "windows.aarch64-msvc"),
});

/** The canonical leaf argv belongs to the native owner; the recipe holds only its exact scope. */
export const nativeGate = defineRun({
  name: "native-gate", version: "1.0.0", inputs: NativeGateRunInput,
  outputs: Schema.Struct({ target: NativeGateInput.fields.target, base: NativeGateInput.fields.base,
    head: NativeGateInput.fields.head, files: Schema.Array(Schema.String) }),
  limits: { maxDurationSec: EXECUTION_SECONDS + FINALIZATION_SECONDS, admissionMaxQueueAgeSec: ADMISSION_SECONDS },
  run: input => Effect.gen(function* () {
    const label = input.target === "x86_64-pc-windows-msvc" ? "windows.x86_64-msvc" : "windows.aarch64-msvc";
    if (label !== input.checkLabel) return yield* Effect.fail(new NativeReceiptRefused({ reason: "native gate label differs from its target" }));
    const handle = yield* step("admit-native-gate", () => nativeExecution.admitGate({ head: input.sha, base: input.baseSha, target: input.target }));
    const deadline = yield* step("native-gate-deadline", () => io.now.pipe(Effect.map(now => now + EXECUTION_SECONDS * 1000)));
    for (let index = 0; ; index++) {
      const now = yield* step(`native-gate-clock-${index}`, () => io.now);
      if (now >= deadline) return yield* Effect.fail(new NativeReceiptRefused({ reason: "native gate deadline exceeded" }));
      const observed = yield* step(`observe-native-gate-${index}`, () => nativeExecution.observeGate(handle));
      if (observed.status === "ready") {
        const completedAt = yield* step(`native-gate-ready-clock-${index}`, () => io.now);
        if (completedAt >= deadline) return yield* Effect.fail(new NativeReceiptRefused({ reason: "native gate deadline exceeded" }));
        return { target: input.target, head: input.sha, base: input.baseSha, files: observed.files.map(file => file.path) };
      }
      yield* step(`sleep-native-gate-${index}`, () => io.sleep("30 seconds"));
    }
  }),
});
