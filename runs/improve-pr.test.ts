// Run-level unit tests for `improve-pr` — drive the run against the in-memory
// test runtime (`makeCFRuntimeTest`) with seeded config + sandbox + model fakes.
// No CF, no Docker, no model provider.

import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import type { ModelCompletionResult } from "@fractalboxdev/flare-dispatch-core";
import { improvePr } from "./improve-pr";

const firedAt = Date.UTC(2026, 5, 3); // 2026-06-03
const input = { firedAt, dimension: "ci-speed" } as const;

/** A tools-mode model result returning the `propose_improvements` payload. */
const report = (findings: unknown[]): ModelCompletionResult => ({
  toolCalls: [
    {
      name: "propose_improvements",
      arguments: { summary: "measured the pipeline", findings },
    },
  ],
  text: "",
});

const finding = (over: Record<string, unknown> = {}) => ({
  title: "Cache the install step",
  location: ".github/workflows/ci.yml",
  measured: "0 steps use a cache action across 3 workflows",
  saving: "~90s per run",
  cost: "one cache key to invalidate, and a stale-cache failure mode",
  percentImprovement: 40,
  proposal: "Add actions/cache keyed on the lockfile hash.",
  ...over,
});

const baseConfig = {
  "improve.repos": "owner/name",
  "improve.workers-ai.model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
};

/** A measurement with content — enough to pass the deterministic exit. */
const measured = { exitCode: 0, stdout: "=== workflow files ===\nname: CI\n" };
const sandboxProgram = { "workflows": measured };

describe("improve-pr", () => {
  it.effect("opens a draft PR carrying the report when a finding clears the floor", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram,
      modelGateway: { responses: [report([finding()])] },
    });

    return Effect.gen(function* () {
      const out = yield* improvePr.run(input);
      expect(out.reposScanned).toBe(1);
      expect(out.prsOpened).toBe(1);
      expect(out.belowFloor).toBe(0);

      const calls = handles.github.openDraftPullRequestCalls;
      expect(calls).toHaveLength(1);
      expect(calls[0]!.headBranch).toBe("flare-dispatch/improve-ci-speed-2026-06-03");
      expect(calls[0]!.files[0]!.path).toBe("improvements/ci-speed/2026-06-03.md");
      // The cost is not optional decoration — it has to reach the artifact.
      expect(calls[0]!.files[0]!.content).toContain("stale-cache failure mode");
    }).pipe(Effect.provide(layer));
  });

  it.effect("proposes nothing when every finding is below the materiality floor", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram,
      modelGateway: { responses: [report([finding({ percentImprovement: 2 })])] },
    });

    return Effect.gen(function* () {
      const out = yield* improvePr.run(input);
      expect(out.prsOpened).toBe(0);
      expect(out.belowFloor).toBe(1);
      expect(out.reposClean).toBe(1);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("honours an operator-lowered materiality floor", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: { ...baseConfig, "improve.materiality-floor": "1" },
      sandboxProgram,
      modelGateway: { responses: [report([finding({ percentImprovement: 2 })])] },
    });

    return Effect.gen(function* () {
      const out = yield* improvePr.run(input);
      expect(out.prsOpened).toBe(1);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("never calls the model when the measurement is empty", () => {
    // The deterministic exit (§7 fence 1): a repo the dimension cannot measure
    // costs nothing, and must not reach a model to discover that.
    const { layer, handles } = makeCFRuntimeTest({
      config: baseConfig,
      sandboxProgram: { workflows: { exitCode: 0, stdout: "" } },
      modelGateway: { responses: [report([finding()])] },
    });

    return Effect.gen(function* () {
      const out = yield* improvePr.run(input);
      expect(out.reposClean).toBe(1);
      expect(out.prsOpened).toBe(0);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("is a no-op when improve.repos is unset", () => {
    const { layer, handles } = makeCFRuntimeTest({ config: {} });
    return Effect.gen(function* () {
      const out = yield* improvePr.run(input);
      expect(out.reposScanned).toBe(0);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails when the backend model is unconfigured", () => {
    const { layer } = makeCFRuntimeTest({ config: { "improve.repos": "owner/name" } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(improvePr.run(input));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it("declares no schedule, so no cron can arm it by accident", () => {
    // §6 staggers one dimension per weekday and arming that is a product
    // decision. A `schedules` entry appearing here without a wrangler cron (or
    // vice versa) is the drift `cron-parity.test.ts` exists to catch.
    expect(improvePr.schedules).toBeUndefined();
  });
});
