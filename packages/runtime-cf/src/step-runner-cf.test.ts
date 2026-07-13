// Unit tests for `buildStepConfig` — the pure StepOpts → CF WorkflowStepConfig
// mapping. The live `StepRunnerCloudflare` (runEffect boundary, D1 lifecycle)
// is exercised in runtime.test.ts against real bindings; this file covers only
// the config derivation, which has no I/O.

import { describe, expect, it } from "vitest";
import { buildStepConfig } from "./step-runner-cf";

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
