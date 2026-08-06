// Tests for `runEffect` — the Workflow-boundary shim. PR4's
// `StepRunnerCloudflare` calls this inside `WorkflowStep.do(...)`: it runs an
// already-provided Effect (`R = never`), returns the value on success, and
// *throws* the typed failure on error so CF Workflows records + retries it.

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ArtifactUploadFailed, ExecFailed } from "./errors";
import { runEffect } from "./step";

describe("runEffect — the Workflow boundary shim", () => {
  it("resolves to the value on success", async () => {
    await expect(runEffect(Effect.succeed(42))).resolves.toBe(42);
  });

  // This used to assert `rejects.toBe(failure)` — that the tagged error itself
  // is thrown. That is precisely what made a failed step unreadable: the tag is
  // the prototype `name` and the detail a prototype `get message()`, and the
  // Workflows attempt record keeps own data properties, so the tagged error
  // arrived as `{"name":"Error","message":""}` naming nothing (#80). The throw
  // is telemetry; the typed failure travels on `cause` (asserted below).
  it("throws an Error whose OWN message names the tag and the detail", async () => {
    const failure = new ExecFailed({ exitCode: 1, stderrTail: "boom" });
    try {
      await runEffect(Effect.fail(failure));
      expect.unreachable("should have thrown");
    } catch (thrown) {
      const own = Object.getOwnPropertyDescriptor(thrown, "message");
      expect(own?.value).toBe("ExecFailed: exec failed (exit 1): boom");
    }
  });

  // The regression guard that the pre-#80 coverage could not be: assert on a
  // SERIALIZED copy. Every assertion against the live instance passed while the
  // record written in production named nothing.
  it("survives serialization with the reason intact", async () => {
    const failure = new ExecFailed({ exitCode: 1, stderrTail: "boom" });
    try {
      await runEffect(Effect.fail(failure));
      expect.unreachable("should have thrown");
    } catch (thrown) {
      // `cause` holds an Effect Cause, which is not structured-cloneable — the
      // boundary reads name/message off the error, so clone just those.
      const wire = structuredClone({
        name: (thrown as Error).name,
        message: (thrown as Error).message,
      });
      expect(wire.message).toContain("ExecFailed");
      expect(wire.message).toContain("exec failed (exit 1): boom");
    }
  });

  // A payload field named `name` shadows `Error.name` on the instance, so the
  // label has to come from the tag or the record is titled with the artifact.
  it("labels by tag even when a payload field shadows Error.name", async () => {
    const failure = new ArtifactUploadFailed({ name: "step.log", cause: "R2 down" });
    try {
      await runEffect(Effect.fail(failure));
      expect.unreachable("should have thrown");
    } catch (thrown) {
      expect((thrown as Error).message).toMatch(/^ArtifactUploadFailed: /);
      expect((thrown as Error).message).toContain("step.log");
    }
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
    await expect(runEffect(Effect.die(new Error("kaboom")))).rejects.toBeInstanceOf(Error);
  });
});
