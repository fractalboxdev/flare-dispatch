// Tests for `runEffect` — the Workflow-boundary shim. PR4's
// `StepRunnerCloudflare` calls this inside `WorkflowStep.do(...)`: it runs an
// already-provided Effect (`R = never`), returns the value on success, and
// *throws* the typed failure on error so CF Workflows records + retries it.

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ExecFailed } from "./errors";
import { runEffect } from "./step";

describe("runEffect — the Workflow boundary shim", () => {
  it("resolves to the value on success", async () => {
    await expect(runEffect(Effect.succeed(42))).resolves.toBe(42);
  });

  it("throws the typed failure on a tagged error", async () => {
    const failure = new ExecFailed({ exitCode: 1, stderrTail: "boom" });
    await expect(runEffect(Effect.fail(failure))).rejects.toBe(failure);
  });

  it("attaches the Cause to the thrown error for downstream serialization", async () => {
    const failure = new ExecFailed({ exitCode: 2, stderrTail: "x" });
    try {
      await runEffect(Effect.fail(failure));
      expect.unreachable("should have thrown");
    } catch (thrown) {
      expect((thrown as { cause?: unknown }).cause).toBeDefined();
    }
  });

  it("throws a rendered Error for a defect (no typed failure)", async () => {
    await expect(
      runEffect(Effect.die(new Error("kaboom"))),
    ).rejects.toBeInstanceOf(Error);
  });
});
