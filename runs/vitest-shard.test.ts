// Run-level unit tests for the `vitest-shard` run.
//
// Exercises the run Effect against the in-memory test runtime
// (`makeCFRuntimeTest` + `sandboxFakeProgram`) — no CF, no Docker, no network.
// Mirrors `matrix-fanout.test.ts`, specialized to Vitest:
//
//   (a) green        — every shard exits 0 → `failed === 0`, `passed === N`.
//   (b) all-red      — every shard exits 1 → the run Effect *succeeds*
//                      (a failing test is a normal ExecResult), `failed === N`.
//   (c) timeout      — a shard raises ExecTimeout → the run Effect *fails*
//                      with the `ExecTimeout` tag, re-failed unchanged.
//   (d) shard flag   — each shard runs `<command> --shard=<i>/<N>` (1-based),
//                      and `install: true` ran the cached dependency install
//                      before the suite.
//
// Plus a determinism guard.
//
// Spec: specs/03-dsl.md § Unit-testing runs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { vitestShard } from "./vitest-shard";

const baseInput = {
  repo: "owner/name",
  sha: "abc123",
  shards: 4,
  command: "pnpm exec vitest run",
  install: true,
} as const;

// Substring the sandbox fake matches against — shared across every shard's
// `... --shard=i/N` command.
const VITEST_CMD = "pnpm exec vitest run";

describe("vitest-shard", () => {
  it.effect("green path — every shard exits 0, failed === 0, passed === shards", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [VITEST_CMD]: { exitCode: 0 } },
    });

    return Effect.gen(function* () {
      const result = yield* vitestShard.run(baseInput);

      expect(result.failed).toBe(0);
      expect(result.passed).toBe(baseInput.shards);
      expect(result.shardResults).toHaveLength(baseInput.shards);
      for (const row of result.shardResults) {
        expect(row.exitCode).toBe(0);
        expect(row.logUri.length).toBeGreaterThan(0);
      }

      // One `run-shards` step; per-shard work is inline.
      expect(handles.executions.steps.map((s) => s.name)).toEqual(["run-shards"]);
      expect(handles.sandbox.acquired).toHaveLength(baseInput.shards);
      expect(handles.sandbox.clones).toHaveLength(baseInput.shards);
    }).pipe(Effect.provide(layer));
  });

  it.effect("all-red — every shard exits 1, the run Effect succeeds, failed === shards", () => {
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: { [VITEST_CMD]: { exitCode: 1, stderr: "1 failing" } },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(vitestShard.run(baseInput));
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.failed).toBe(baseInput.shards);
        expect(exit.value.passed).toBe(0);
        expect(exit.value.shardResults.every((r) => r.exitCode === 1)).toBe(true);
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("timeout — a shard raises ExecTimeout, the run re-fails with the same tag", () => {
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: { [VITEST_CMD]: { fail: "ExecTimeout", timeoutSec: 600 } },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(vitestShard.run(baseInput));
      expect(Exit.isFailure(exit)).toBe(true);
      const tag = Exit.isFailure(exit)
        ? Option.match(Cause.failureOption(exit.cause), {
            onSome: (f) => (f as { _tag?: string })._tag,
            onNone: () => undefined,
          })
        : undefined;
      expect(tag).toBe("ExecTimeout");
    }).pipe(Effect.provide(layer));
  });

  it.effect("shard flag — each shard runs `<command> --shard=<i>/<N>`; install ran first", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [VITEST_CMD]: { exitCode: 0 } },
    });

    return Effect.gen(function* () {
      yield* vitestShard.run(baseInput);

      const commands = handles.sandbox.execs.map((e) => e.command);

      // Every shard's Vitest invocation carries its own 1-based shard
      // coordinate appended to the base command.
      const shardCmds = commands.filter((c) => c.includes("--shard=")).sort();
      expect(shardCmds).toEqual([
        "pnpm exec vitest run --shard=1/4",
        "pnpm exec vitest run --shard=2/4",
        "pnpm exec vitest run --shard=3/4",
        "pnpm exec vitest run --shard=4/4",
      ]);

      // install: true ran the cached dependency install (detected pnpm from
      // the lockfile) in every shard before the suite.
      expect(commands).toContain("pnpm install --frozen-lockfile");
    }).pipe(Effect.provide(layer));
  });
});

// --- Source guard: no direct Date.now() / crypto.randomUUID() in the run -----
describe("vitest-shard source determinism", () => {
  it.effect("the run body never calls Date.now()/crypto.randomUUID()", () =>
    Effect.sync(() => {
      const src = readFileSync(
        fileURLToPath(new URL("./vitest-shard.ts", import.meta.url)),
        "utf8",
      );
      const code = src.replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/\bDate\s*\.\s*now\b/);
      expect(code).not.toMatch(/\bcrypto\s*\.\s*randomUUID\b/);
      expect(code).not.toMatch(/\bMath\s*\.\s*random\b/);
    }),
  );
});
