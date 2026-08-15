// Unit tests for `buildStepConfig` — the pure StepOpts → CF WorkflowStepConfig
// mapping. The live `StepRunnerCloudflare` (runEffect boundary, D1 lifecycle)
// is exercised in runtime.test.ts against real bindings; this file covers only
// the config derivation, which has no I/O.

import { Cause, Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  CheckoutFailed,
  ExecFailed,
  ExecTimeout,
  runEffect,
} from "@fractalboxdev/flare-dispatch-core";
import { buildStepConfig, rethrowForRetryPolicy } from "./step-runner-cf";

const thrownFor = async (failure: ExecFailed | ExecTimeout | CheckoutFailed): Promise<unknown> => {
  try {
    await runEffect(Effect.fail(failure));
    throw new Error("expected a throw");
  } catch (error) {
    return error;
  }
};

describe("buildStepConfig", () => {
  it("returns undefined when no opts are given (bare do(name, cb))", () => {
    expect(buildStepConfig(undefined)).toBeUndefined();
  });

  it("returns undefined when opts carry neither timeoutSec nor retries", () => {
    expect(buildStepConfig({ metadata: { k: "v" } })).toBeUndefined();
  });

  it("maps timeoutSec to a CF duration string", () => {
    expect(buildStepConfig({ timeoutSec: 1740 })).toEqual({
      timeout: "1740 seconds",
    });
  });

  it("maps retries to a bounded exponential-backoff policy", () => {
    expect(buildStepConfig({ retries: 3 })).toEqual({
      retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
    });
  });

  it("includes both timeout and retries when both are set", () => {
    expect(buildStepConfig({ timeoutSec: 1740, retries: 2 })).toEqual({
      timeout: "1740 seconds",
      retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
    });
  });

  it("treats timeoutSec: 0 as set (a deliberate zero timeout)", () => {
    // 0 !== undefined, so it is honored — a run that asks for 0 gets "0 seconds"
    // rather than silently falling back to CF's default.
    expect(buildStepConfig({ timeoutSec: 0 })).toEqual({ timeout: "0 seconds" });
  });
});

describe("rethrowForRetryPolicy", () => {
  it("passes a listed tag through, so the platform retries it", async () => {
    const thrown = await thrownFor(new ExecFailed({ exitCode: -1, stderrTail: "boom" }));
    expect(rethrowForRetryPolicy(thrown, ["ExecFailed"])).toBe(thrown);
  });

  it("marks an unlisted tag non-retryable, preserving the Cause", async () => {
    const thrown = await thrownFor(new ExecTimeout({ timeoutSec: 600, command: "pnpm test" }));
    const out = rethrowForRetryPolicy(thrown, ["ExecFailed"]) as Error & { cause?: unknown };

    expect(out).not.toBe(thrown);
    expect(out.name).toBe("NonRetryableError");
    expect(Cause.isCause(out.cause)).toBe(true);
  });

  it("CheckoutFailed passes through under the runs' policy, so the rebuild's own clone retries", async () => {
    const thrown = await thrownFor(new CheckoutFailed({ repo: "o/r", sha: "abc", cause: "flake" }));
    expect(rethrowForRetryPolicy(thrown, ["ExecFailed", "StepFailed", "CheckoutFailed"])).toBe(
      thrown,
    );
  });

  it("CheckoutFailed is non-retryable under a policy that omits it", async () => {
    const thrown = await thrownFor(new CheckoutFailed({ repo: "o/r", sha: "abc", cause: "flake" }));
    const out = rethrowForRetryPolicy(thrown, ["ExecFailed", "StepFailed"]) as Error;
    expect(out).not.toBe(thrown);
    expect(out.name).toBe("NonRetryableError");
  });

  it("without retryOn every failure stays retryable — the platform default", async () => {
    const thrown = await thrownFor(new ExecTimeout({ timeoutSec: 600, command: "pnpm test" }));
    expect(rethrowForRetryPolicy(thrown, undefined)).toBe(thrown);
  });
});
