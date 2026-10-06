import { it } from "@effect/vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { contextfulMeasures, reportCommand, runAttempt } from "./contextful-measures";

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
  it("builds a newline-terminated report from every record with the execution attempt", () => {
    const dir = mkdtempSync(join(tmpdir(), "contextful-measures-"));
    try {
      const recordsDir = join(dir, "target/evaluate/records");
      mkdirSync(recordsDir, { recursive: true });
      writeFileSync(join(recordsDir, "b.json"), '{"tier":"b","passed":false}');
      writeFileSync(join(recordsDir, "a.json"), '{"tier":"a","passed":true}');
      const result = spawnSync("sh", ["-c", reportCommand], {
        cwd: dir,
        env: {
          ...process.env,
          MEASURE_COMMIT: sha,
          MEASURE_RUN_ID: "contextful_measures_attempt-2",
          MEASURE_RUN_ATTEMPT: "2",
          MEASURE_EXIT: "3",
        },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const text = readFileSync(join(dir, "measure-report.json"), "utf8");
      expect(text.endsWith("\n")).toBe(true);
      expect(JSON.parse(text)).toEqual({
        commit: sha,
        run_id: "contextful_measures_attempt-2",
        run_attempt: 2,
        exit_code: 3,
        records: [
          { tier: "a", passed: true },
          { tier: "b", passed: false },
        ],
      });
      expect(runAttempt("contextful_measures_attempt-2")).toBe(2);
      expect(runAttempt("contextful_measures_daily")).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.effect("measures the resolved default-branch SHA and attaches its report", () => {
    const { layer, handles } = makeCFRuntimeTest({
      executionId: "contextful_measures_attempt-2",
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
      const reportExec = handles.sandbox.execs.find((entry) => entry.command.startsWith("node -e"));
      expect(reportExec?.env?.MEASURE_RUN_ID).toBe("contextful_measures_attempt-2");
      expect(reportExec?.env?.MEASURE_RUN_ATTEMPT).toBe("2");
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
