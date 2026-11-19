import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { NativeControllerCheckpoint } from "./native-controller-checkpoint";

const clock = { admittedAt: 1_791_438_400 };
const published = { _tag: "Published", ...clock, runId: 123, runAttempt: 1, manifestKey: "native-results/v1/fixture.json" };
const decode = (raw: unknown) => Effect.runPromise(Schema.decodeUnknown(NativeControllerCheckpoint, { onExcessProperty: "error" })(raw));

describe("native checkpoint boundary", () => {
  it("refuses oversized UTF8 metadata even when its character count fits the Workflow ceiling", async () => {
    const result = await Effect.runPromise(Schema.decodeUnknown(NativeControllerCheckpoint, { onExcessProperty: "error" })
      ({ ...published, manifestKey: "é".repeat(600_000) }).pipe(Effect.either));
    expect(Either.isLeft(result)).toBe(true);
  });
  it("admits serializable lifecycle metadata below the checkpoint ceiling", async () => {
    expect(await decode(published)).toEqual(published);
    expect(await decode({ _tag: "WaitingForRun", ...clock })).toEqual({ _tag: "WaitingForRun", ...clock });
  });
  it.each([{ runId: 0 }, { runId: Number.MAX_SAFE_INTEGER + 1 }, { runAttempt: 1.5 }, { admittedAt: 0 },
    { admittedAt: NaN }, { admittedAt: Number.MAX_SAFE_INTEGER }])("refuses malformed controller identity or admission time %j", async (fields) => {
    await expect(decode({ ...published, ...fields })).rejects.toThrow();
  });
  it.each([{ token: "fixture-secret" }, { result: { receipt: {} } }, { manifestKey: "" }])("refuses body/credential fields and empty result keys %j", async (fields) => {
    await expect(decode({ ...published, ...fields })).rejects.toThrow();
  });
});
