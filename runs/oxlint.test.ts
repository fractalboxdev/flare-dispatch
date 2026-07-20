// Run-level unit tests for the `oxlint` run.
//
// Exercise the run Effect against the in-memory test runtime
// (`makeCFRuntimeTest` + `sandboxFakeProgram`) — no CF, no Docker, no network.
// Mirrors `offload-test.test.ts`, narrowed to oxlint's surface:
//
//   (a) green path  — oxlint exits 0 → output `.exitCode === 0`, no install step
//   (b) red path    — oxlint exits 1, `failOnNonZeroExit` default ON → the run
//                     Effect *fails* with `AcceptanceFailed` carrying the exit
//   (c) advisory    — `failOnNonZeroExit: false` → exit 1 is a successful Effect
//   (d) command     — `version` + `args` compose the `npx oxlint@<v> <args>` line
//   (e) webhook trig — the pull_request payload maps to inputs; gate skips
//                     drafts/dependabot
//
// Spec: specs/03-dsl.md § Unit-testing runs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { oxlint } from "./oxlint";

/** Default decoded input — version "1", empty args, fail-on-nonzero ON. */
const baseInput = {
  repo: "owner/name",
  sha: "abc123",
  args: "",
  version: "1",
  failOnNonZeroExit: true,
} as const;

/** The command the default input produces. */
const CMD_DEFAULT = "npx --yes oxlint@1";

describe("oxlint", () => {
  it.effect("green path — oxlint exits 0, no install, three steps", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [CMD_DEFAULT]: { exitCode: 0 } },
    });

    return Effect.gen(function* () {
      const result = yield* oxlint.run(baseInput);

      expect(result.exitCode).toBe(0);
      expect(typeof result.logUri).toBe("string");
      expect(result.logUri.length).toBeGreaterThan(0);

      // checkout → exec → upload-log, all successful. Crucially NO install
      // step / install command — oxlint needs no node_modules.
      expect(handles.executions.steps.map((s) => s.name)).toEqual([
        "checkout",
        "exec",
        "upload-log",
      ]);
      expect(handles.sandbox.execs.map((e) => e.command)).toEqual([
        CMD_DEFAULT,
      ]);
      expect(
        handles.sandbox.execs
          .map((e) => e.command)
          .some((c) => c.includes("install")),
      ).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "red path — exit 1 with failOnNonZeroExit ON fails with AcceptanceFailed carrying the exit",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [CMD_DEFAULT]: { exitCode: 1, stderr: "1 error" } },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(oxlint.run(baseInput));

        expect(Exit.isFailure(exit)).toBe(true);
        const failure = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.failureOption(exit.cause))
          : undefined;
        expect((failure as { _tag?: string })?._tag).toBe("AcceptanceFailed");
        expect((failure as { exitCode?: number })?.exitCode).toBe(1);

        // The lint still ran end-to-end — the failure is the verdict.
        expect(handles.executions.steps.map((s) => s.name)).toEqual([
          "checkout",
          "exec",
          "upload-log",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  // --- Nothing to lint -------------------------------------------------------
  //
  // oxlint exits 1, printing `No files found to lint.` on stdout, when the tree
  // holds no file it can lint — a repo with no JS/TS at all (Rust/Python/Go/
  // docs-only), an all-gitignored tree, or an `args` filter matching nothing.
  // The install-free gate is meant to be droppable on ANY repo, so that exit is
  // a no-op, not a lint verdict, and must not go red.

  /** oxlint's verbatim empty-file-set output (oxlint 1.x, on stdout). */
  const NO_FILES_STDOUT =
    "No files found to lint. Please check your paths and ignore patterns.\n";

  it.effect(
    "nothing to lint — the exit-1 sentinel is a green skip, NOT a red lint verdict",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: {
          [CMD_DEFAULT]: { exitCode: 1, stdout: NO_FILES_STDOUT },
        },
      });

      return Effect.gen(function* () {
        // failOnNonZeroExit is ON (the default, and what the webhook trigger
        // hard-codes) — yet the run SUCCEEDS.
        const exit = yield* Effect.exit(oxlint.run(baseInput));
        expect(Exit.isSuccess(exit)).toBe(true);
        if (!Exit.isSuccess(exit)) return;

        // Normalized to 0 so an Action-mode caller gating on `exitCode` (the
        // `offload-test` contract) stays green too...
        expect(exit.value.exitCode).toBe(0);
        // ...with the truth out of band: a pass over ZERO files, which nothing
        // should read as "oxlint vouched for this code".
        expect(exit.value.skipped).toBe(true);

        // The log still uploads — it carries the sentinel as the evidence.
        expect(handles.executions.steps.map((s) => s.name)).toEqual([
          "checkout",
          "exec",
          "upload-log",
        ]);
        expect(exit.value.logUri.length).toBeGreaterThan(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "nothing to lint — a genuine finding on the same exit code still goes red",
    () => {
      // Guards the reclassification against over-reach: exit 1 WITHOUT the
      // sentinel is a real lint verdict and must still fail the run.
      const { layer } = makeCFRuntimeTest({
        sandboxProgram: {
          [CMD_DEFAULT]: {
            exitCode: 1,
            stdout:
              "  x eslint(no-unused-vars): 'foo' is never used\n   ╭─[src/x.ts:1:7]\n\nFound 1 error.",
          },
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(oxlint.run(baseInput));
        expect(Exit.isFailure(exit)).toBe(true);
        const failure = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.failureOption(exit.cause))
          : undefined;
        expect((failure as { _tag?: string })?._tag).toBe("AcceptanceFailed");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a clean lint over real files is NOT reported as skipped", () => {
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: { [CMD_DEFAULT]: { exitCode: 0 } },
    });

    return Effect.gen(function* () {
      const result = yield* oxlint.run(baseInput);
      expect(result.exitCode).toBe(0);
      expect(result.skipped).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "advisory mode — failOnNonZeroExit off makes a finding a successful Effect surfacing exitCode",
    () => {
      const { layer } = makeCFRuntimeTest({
        sandboxProgram: { [CMD_DEFAULT]: { exitCode: 1 } },
      });
      const input = { ...baseInput, failOnNonZeroExit: false };

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(oxlint.run(input));
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) expect(exit.value.exitCode).toBe(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "command — version + args compose the npx oxlint invocation",
    () => {
      const command = "npx --yes oxlint@1.2.3 src --deny-warnings";
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [command]: { exitCode: 0, durationMs: 1234 } },
      });
      const input = {
        ...baseInput,
        version: "1.2.3",
        args: "src --deny-warnings",
      };

      return Effect.gen(function* () {
        const result = yield* oxlint.run(input);
        expect(result.exitCode).toBe(0);
        // durationMs is the checkpointed exec result's value (replay-safe).
        expect(result.durationMs).toBe(1234);
        expect(handles.sandbox.execs.map((e) => e.command)).toEqual([command]);
      }).pipe(Effect.provide(layer));
    },
  );

  // --- Webhook trigger -------------------------------------------------------

  const prPayload = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    action: "synchronize",
    repository: { full_name: "owner/name" },
    pull_request: {
      draft: false,
      head: { sha: "abcdef0123456789cafe" },
      user: { login: "alice" },
    },
    ...overrides,
  });

  it("webhook trigger — maps the pull_request payload to inputs", () => {
    const trigger = oxlint.triggers?.[0];
    expect(trigger?.event).toBe("pull_request");
    expect(trigger?.actions).toContain("synchronize");

    const ctx = { payload: prPayload() };
    expect(trigger?.inputs(ctx)).toEqual({
      repo: "owner/name",
      sha: "abcdef0123456789cafe",
      args: "",
      version: "1",
      failOnNonZeroExit: true,
    });
    expect(trigger?.idempotencyKey(ctx)).toBe("oxlint:owner_name:abcdef012345");
  });

  it("webhook trigger — gate skips drafts and dependabot, admits real PRs", () => {
    const gate = oxlint.triggers?.[0]?.gate;
    expect(gate?.({ payload: prPayload() })).toBe(true);
    expect(
      gate?.({
        payload: prPayload({
          pull_request: {
            draft: true,
            head: { sha: "abcdef0123456789cafe" },
            user: { login: "alice" },
          },
        }),
      }),
    ).toBe(false);
    expect(
      gate?.({
        payload: prPayload({
          pull_request: {
            draft: false,
            head: { sha: "abcdef0123456789cafe" },
            user: { login: "dependabot[bot]" },
          },
        }),
      }),
    ).toBe(false);
  });
});

// --- Source guard: no direct Date.now() / crypto.randomUUID() in the run -----
describe("oxlint source determinism", () => {
  it.effect("the run body never calls Date.now()/crypto.randomUUID()", () =>
    Effect.sync(() => {
      const src = readFileSync(
        fileURLToPath(new URL("./oxlint.ts", import.meta.url)),
        "utf8",
      );
      const code = src.replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/\bDate\s*\.\s*now\b/);
      expect(code).not.toMatch(/\bcrypto\s*\.\s*randomUUID\b/);
      expect(code).not.toMatch(/\bMath\s*\.\s*random\b/);
    }),
  );
});
