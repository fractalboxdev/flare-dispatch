import { it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { contextfulGate, mergeStages, parseStages } from "./contextful-gate";

const SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const DISCOVER = "cargo run --locked -q -p contextful-ci -- stages --parts";
const input = { repo: "fractalboxdev/contextful", sha: SHA, baseSha: BASE_SHA } as const;

describe("contextful-gate", () => {
  it("accepts one unique check label per stage", () => {
    expect(parseStages("pins\nworkspace.compile\nbudget.full\n")).toEqual([
      "pins",
      "workspace.compile",
      "budget.full",
    ]);
    expect(parseStages("\n")).toBeUndefined();
    expect(parseStages("pins\npins\n")).toBeUndefined();
    expect(parseStages("pins\nunsafe; command\n")).toBeUndefined();
    expect(
      parseStages(Array.from({ length: 33 }, (_, i) => `part${i}`).join("\n")),
    ).toBeUndefined();
    expect(parseStages(" ".repeat(2049))).toBeUndefined();
  });

  it("keeps base stages when the head removes them", () => {
    expect(mergeStages(["pins", "formal"], ["pins", "workspace.compile"])).toEqual([
      "pins",
      "formal",
      "workspace.compile",
    ]);
  });

  it("admits draft same-repo PRs and refuses fork heads", () => {
    const trigger = contextfulGate.triggers?.[0];
    expect(trigger?.event).toBe("pull_request");
    expect(trigger?.actions).toEqual(["opened", "synchronize", "reopened", "ready_for_review"]);
    const payload = {
      repository: { full_name: input.repo },
      pull_request: {
        draft: true,
        head: { sha: SHA, repo: { full_name: input.repo } },
        base: { sha: BASE_SHA },
      },
    };
    expect(trigger?.gate?.({ payload } as never)).toBe(true);
    expect(trigger?.inputs({ payload } as never)).toEqual(input);
    expect(
      trigger?.gate?.({
        payload: {
          ...payload,
          pull_request: {
            ...payload.pull_request,
            head: { ...payload.pull_request.head, repo: { full_name: "fork/contextful" } },
          },
        },
      } as never),
    ).toBe(false);
  });

  it.effect("spawns at most two stages per wave and reports every stage", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [DISCOVER]: { stdout: "pins\nworkspace.compile\nformal\n", exitCode: 0 } },
      childRuns: {
        pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })),
      },
    });
    return Effect.gen(function* () {
      const output = yield* contextfulGate.run(input);
      expect(output).toEqual({ stages: 3, failed: [] });
      expect(handles.childRuns.spawned.map((spawn) => spawn.input)).toEqual([
        expect.objectContaining({
          checkLabel: "pins",
          command: expect.stringContaining(`--stage pins --base ${BASE_SHA}`),
        }),
        expect.objectContaining({
          checkLabel: "workspace.compile",
          command: expect.stringContaining(`--stage workspace.compile --base ${BASE_SHA}`),
        }),
        expect.objectContaining({
          checkLabel: "formal",
          command: expect.stringContaining(`--stage formal --base ${BASE_SHA}`),
        }),
      ]);
      expect(handles.executions.steps.map((entry) => entry.name)).toEqual([
        "checkout",
        "discover-stages",
        "checkout-base",
        "discover-base-stages",
        "spawn-stages-0",
        "await-stages-0",
        "spawn-stages-2",
        "await-stages-2",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails its own check when discovery fails", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [DISCOVER]: { stdout: "", exitCode: 1 } },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(contextfulGate.run(input));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(handles.childRuns.spawned).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("continues after a red child and makes the parent red", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [DISCOVER]: { stdout: "pins\nworkspace.compile\nformal\n", exitCode: 0 } },
      childRuns: {
        pollFn: (ids) =>
          ids.map((executionId) => ({
            executionId,
            status: executionId.includes("check:0") ? "failure" : "success",
          })),
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(contextfulGate.run(input));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(Cause.pretty(exit.cause)).toContain("Gate stages failed: pins");
      expect(handles.childRuns.spawned).toHaveLength(3);
    }).pipe(Effect.provide(layer));
  });
});
