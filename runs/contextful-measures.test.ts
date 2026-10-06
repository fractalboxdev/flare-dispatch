import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { contextfulMeasures } from "./contextful-measures";

const sha = "a".repeat(40);
const input = {
  repo: "fractalboxdev/contextful",
  ref: "refs/heads/main",
  firedAt: Date.UTC(2026, 9, 6, 2, 17),
};
const report = JSON.stringify({
  commit: sha,
  run_id: "contextful-measures:1791253020000",
  run_attempt: 1,
  exit_code: 0,
  records: [],
});

describe("contextful-measures", () => {
  it.effect("measures the resolved default-branch SHA and attaches its report", () => {
    const { layer, handles } = makeCFRuntimeTest({
      github: { branchHeads: { "fractalboxdev/contextful:main": sha } },
      sandboxProgram: { "cargo run --locked": { exitCode: 0 }, "node -e": { exitCode: 0 } },
      sandboxFiles: { "/workspace/contextful/measure-report.json": report },
    });
    return Effect.gen(function* () {
      const out = yield* contextfulMeasures.run(input);
      expect(out.commit).toBe(sha);
      expect(handles.sandbox.clones).toEqual([{ repo: input.repo, sha }]);
      expect(handles.github.appendMeasureNoteCalls).toEqual([
        { repo: input.repo, commit: sha, text: report },
      ]);
      expect(handles.artifact.uploads[0]?.name).toBe("measure-report.json");
    }).pipe(Effect.provide(layer));
  });

  it.effect("attaches a report even when a measure tier is red", () => {
    const { layer, handles } = makeCFRuntimeTest({
      github: { branchHeads: { "fractalboxdev/contextful:main": sha } },
      sandboxProgram: { "cargo run --locked": { exitCode: 3 }, "node -e": { exitCode: 0 } },
      sandboxFiles: { "/workspace/contextful/measure-report.json": report },
    });
    return Effect.gen(function* () {
      const result = yield* Effect.exit(contextfulMeasures.run(input));
      expect(Exit.isFailure(result)).toBe(true);
      expect(handles.github.appendMeasureNoteCalls).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });
});
