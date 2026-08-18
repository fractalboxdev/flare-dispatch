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
//   (e) version     — resolution ladder: dispatch → per-repo CONFIG_KV →
//                     dispatcher-wide CONFIG_KV → the pinned default, and the
//                     default is an EXACT version, never a range
//   (f) webhook trig — the pull_request payload maps to inputs; gate skips
//                     drafts/dependabot
//
// Spec: specs/03-dsl.md § Unit-testing runs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { oxlint, VERSION_DEFAULT } from "./oxlint";

/**
 * Default decoded input — an EXPLICIT version, empty args, fail-on-nonzero ON.
 * Carrying the version keeps these cases on the three-step Action-mode shape;
 * the resolution ladder that webhook mode walks has its own block below.
 */
const baseInput = {
  repo: "owner/name",
  sha: "abc123",
  args: "",
  version: "1.74.0",
  failOnNonZeroExit: true,
} as const;

/** The command the default input produces. */
const CMD_DEFAULT = "npx --yes oxlint@1.74.0";

/** The command a version-less dispatch produces with nothing in CONFIG_KV. */
const CMD_PINNED = `npx --yes oxlint@${VERSION_DEFAULT}`;

/**
 * `ensureWorkspace`'s checkout probe, which precedes the oxlint command in
 * every run — the version cases assert on the command that follows it.
 */
const PROBE = "test -d /workspace/name/.git";

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
      // The probe precedes the command: the checkout is re-established inside
      // the retryable step, so a container recycled between steps is rebuilt
      // rather than retried into.
      expect(handles.sandbox.execs.map((e) => e.command)).toEqual([
        "test -d /workspace/name/.git",
        CMD_DEFAULT,
      ]);
      expect(handles.sandbox.execs.map((e) => e.command).some((c) => c.includes("install"))).toBe(
        false,
      );
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
  const NO_FILES_STDOUT = "No files found to lint. Please check your paths and ignore patterns.\n";

  it.effect("nothing to lint — the exit-1 sentinel is a green skip, NOT a red lint verdict", () => {
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
  });

  it.effect("nothing to lint — a genuine finding on the same exit code still goes red", () => {
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
  });

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

  it.effect("command — version + args compose the npx oxlint invocation", () => {
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
      expect(handles.sandbox.execs.map((e) => e.command)).toEqual([
        "test -d /workspace/name/.git",
        command,
      ]);
    }).pipe(Effect.provide(layer));
  });

  // --- Version resolution ----------------------------------------------------
  //
  // The gate's rule set is decided by which oxlint it fetches, so the version
  // must never be a moving target: oxlint selects rules by CATEGORY, and a
  // minor release that moves a rule into `correctness` turns every consumer on
  // a floating range red at once, for findings that predated all of them.

  it("the default is an exact version — never a range or a dist-tag", () => {
    expect(VERSION_DEFAULT).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.effect("no version anywhere — the run uses the pinned default", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [CMD_PINNED]: { exitCode: 0 } },
    });
    const { version: _omitted, ...input } = baseInput;

    return Effect.gen(function* () {
      const result = yield* oxlint.run(input);
      expect(result.exitCode).toBe(0);
      expect(handles.sandbox.execs.map((e) => e.command)).toEqual([PROBE, CMD_PINNED]);
      // Resolution is its own checkpointed step in webhook mode.
      expect(handles.executions.steps.map((s) => s.name)).toEqual([
        "resolve-version",
        "checkout",
        "exec",
        "upload-log",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("per-repo CONFIG_KV pins the version, beating the dispatcher-wide key", () => {
    const command = "npx --yes oxlint@1.74.0";
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [command]: { exitCode: 0 } },
      config: {
        "oxlint.version:owner/name": "1.74.0",
        "oxlint.version": "1.78.0",
      },
    });
    const { version: _omitted, ...input } = baseInput;

    return Effect.gen(function* () {
      yield* oxlint.run(input);
      expect(handles.sandbox.execs.map((e) => e.command)).toEqual([PROBE, command]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("dispatcher-wide CONFIG_KV applies when no per-repo key is set", () => {
    const command = "npx --yes oxlint@1.78.0";
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [command]: { exitCode: 0 } },
      config: { "oxlint.version": "1.78.0" },
    });
    const { version: _omitted, ...input } = baseInput;

    return Effect.gen(function* () {
      yield* oxlint.run(input);
      expect(handles.sandbox.execs.map((e) => e.command)).toEqual([PROBE, command]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a dispatched version wins over both keys, and skips the resolve step", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [CMD_DEFAULT]: { exitCode: 0 } },
      config: { "oxlint.version:owner/name": "1.78.0", "oxlint.version": "1.77.0" },
    });

    return Effect.gen(function* () {
      yield* oxlint.run(baseInput);
      expect(handles.sandbox.execs.map((e) => e.command)).toEqual([PROBE, CMD_DEFAULT]);
      expect(handles.executions.steps.map((s) => s.name)).toEqual([
        "checkout",
        "exec",
        "upload-log",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a blank CONFIG_KV value falls through rather than producing `oxlint@`", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [CMD_PINNED]: { exitCode: 0 } },
      config: { "oxlint.version:owner/name": "   ", "oxlint.version": "" },
    });
    const { version: _omitted, ...input } = baseInput;

    return Effect.gen(function* () {
      yield* oxlint.run(input);
      expect(handles.sandbox.execs.map((e) => e.command)).toEqual([PROBE, CMD_PINNED]);
    }).pipe(Effect.provide(layer));
  });

  // --- Webhook trigger -------------------------------------------------------

  const prPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
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
      failOnNonZeroExit: true,
    });
    // The version is deliberately ABSENT — pinning it here would pin every
    // repo the dispatcher serves, unreachable from any of them.
    expect(trigger?.inputs(ctx)).not.toHaveProperty("version");
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
      const src = readFileSync(fileURLToPath(new URL("./oxlint.ts", import.meta.url)), "utf8");
      const code = src.replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/\bDate\s*\.\s*now\b/);
      expect(code).not.toMatch(/\bcrypto\s*\.\s*randomUUID\b/);
      expect(code).not.toMatch(/\bMath\s*\.\s*random\b/);
    }),
  );

  it.effect("the exec step retries the platform, never a lint verdict", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [CMD_DEFAULT]: { exitCode: 0 } },
    });
    return Effect.gen(function* () {
      yield* oxlint.run(baseInput);
      const execStep = handles.executions.steps.find((s) => s.name === "exec");
      // oxlint exiting non-zero is a normal ExecResult decided by the run body,
      // so `retryOn: ExecFailed` can only ever cover the container.
      expect(execStep?.metadata?.["stepOpts.retries"]).toBe(3);
      expect(execStep?.metadata?.["stepOpts.retryOn"]).toEqual(["ExecFailed", "StepFailed"]);
    }).pipe(Effect.provide(layer));
  });
});
