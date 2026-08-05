// Run-level unit tests for the `offload-test` run.
//
// These exercise the run Effect against the in-memory test runtime
// (`makeCFRuntimeTest` + `sandboxFakeProgram`) — no CF, no Docker, no network.
// The three acceptance cases from specs/pm/plan.md § PR3:
//
//   (a) green path  — fake `pnpm test` exits 0  → output `.exitCode === 0`
//   (b) red path    — fake `pnpm test` exits 1  → output `.exitCode === 1`,
//                      the run Effect *succeeds* (a non-zero exit is a normal
//                      ExecResult, never an Effect failure — specs/03-dsl.md
//                      § sandbox)
//   (c) timeout     — fake `exec` raises ExecTimeout → the run Effect *fails*
//                      with the `ExecTimeout` tag, re-failed unchanged
//   (d) secrets     — config-store secrets are resolved by `loadSecrets` and
//                      injected into the exec env (per-dispatch `env` wins on
//                      a key collision); a named-but-unset key fails the run
//                      with `SecretsMissing` before the exec
//   (e) install     — `install: true` runs the R2-cached dependency install
//                      inside the checkout step; the `image` override reaches
//                      the container acquire
//
// Plus a determinism guard: the run body must not call `Date.now()` /
// `crypto.randomUUID()` directly — non-determinism flows only through `io`,
// and `durationMs` is sourced from the checkpointed `exec` step result so it
// is stable across Workflow replays (specs/pm/plan.md § 6 "Run replay
// determinism").
//
// Spec: specs/pm/plan.md § PR3, specs/03-dsl.md § Unit-testing runs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { offloadTest } from "./offload-test";

const baseInput = {
  repo: "owner/name",
  sha: "abc123",
  command: "pnpm test",
  secrets: [] as readonly string[],
  install: false,
  failOnNonZeroExit: false,
} as const;

describe("offload-test", () => {
  it.effect("green path — exec exits 0, output reports exitCode 0", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "pnpm test": { exitCode: 0 } },
    });

    return Effect.gen(function* () {
      const result = yield* offloadTest.run(baseInput);

      expect(result.exitCode).toBe(0);
      expect(typeof result.logUri).toBe("string");
      expect(result.logUri.length).toBeGreaterThan(0);

      // checkout → exec → upload-log, each recorded once, all successful.
      expect(handles.executions.steps.map((s) => s.name)).toEqual([
        "checkout",
        "exec",
        "upload-log",
      ]);
      expect(handles.executions.steps.every((s) => s.status === "success")).toBe(true);
      expect(handles.sandbox.clones).toHaveLength(1);
      expect(handles.sandbox.clones[0]).toEqual({
        repo: "owner/name",
        sha: "abc123",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("red path — exec exits 1, output reports exitCode 1 and the Effect succeeds", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        "pnpm test": { exitCode: 1, stderr: "1 failing" },
      },
    });

    return Effect.gen(function* () {
      // The run Effect must *succeed* — a failing test is a normal result,
      // surfaced as `exitCode`, not an Effect failure.
      const exit = yield* Effect.exit(offloadTest.run(baseInput));

      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.exitCode).toBe(1);
      }

      // All three steps still recorded as successful — a non-zero exit does
      // not fail the `exec` step.
      expect(handles.executions.steps.every((s) => s.status === "success")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("timeout — exec raises ExecTimeout, the run re-fails with the same tag", () => {
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: {
        "pnpm test": { fail: "ExecTimeout", timeoutSec: 600 },
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(offloadTest.run(baseInput));

      expect(Exit.isFailure(exit)).toBe(true);
      // The failure is the `ExecTimeout` tag, not swallowed, not remapped.
      const tag = Exit.isFailure(exit)
        ? Option.match(Cause.failureOption(exit.cause), {
            onSome: (f) => (f as { _tag?: string })._tag,
            onNone: () => undefined,
          })
        : undefined;
      expect(tag).toBe("ExecTimeout");
    }).pipe(Effect.provide(layer));
  });

  it.effect("durationMs is the checkpointed exec ExecResult's durationMs", () => {
    // The run reports `result.durationMs` straight from the `exec` step's
    // `ExecResult` — the replay-safe source, since only step results are
    // memoized across Workflow replays. The run must not recompute it from
    // wall-clock reads. Pin a distinctive `durationMs` on the canned exec
    // result and assert the run output carries exactly that value.
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: { "pnpm test": { exitCode: 0, durationMs: 4242 } },
    });

    return Effect.gen(function* () {
      const result = yield* offloadTest.run(baseInput);
      expect(result.durationMs).toBe(4242);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "install — runs the cached dependency install in the checkout, image override reaches acquire",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
      });
      const input = { ...baseInput, install: true, image: "custom/image:1" };

      return Effect.gen(function* () {
        const result = yield* offloadTest.run(input);
        expect(result.exitCode).toBe(0);

        // The container acquire honours the `image` override (previously the
        // input was declared but never threaded).
        expect(handles.sandbox.acquired[0]).toEqual({ image: "custom/image:1" });

        // `installCached` detected pnpm from the lockfile probe and — the test
        // Cache fake always misses — ran the real install before the command.
        const commands = handles.sandbox.execs.map((e) => e.command);
        expect(commands).toContain("pnpm install --frozen-lockfile");
        expect(commands.indexOf("pnpm install --frozen-lockfile")).toBeLessThan(
          commands.indexOf("pnpm test"),
        );

        // Still exactly the three run steps — the install lives inside
        // `checkout`, not a fourth step.
        expect(handles.executions.steps.map((s) => s.name)).toEqual([
          "checkout",
          "exec",
          "upload-log",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "webhook exec options — install + timeoutSec resolve from CONFIG_KV when the dispatch omits them",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
        config: {
          "offload-test.command:owner/name": "pnpm test",
          "offload-test.install:owner/name": "true",
          "offload-test.timeoutSec:owner/name": "1800",
        },
      });
      // Webhook-shaped: no command, no install, no timeoutSec.
      const input = {
        repo: "owner/name",
        sha: "abc123",
        secrets: [] as readonly string[],
        failOnNonZeroExit: true,
      };

      return Effect.gen(function* () {
        const result = yield* offloadTest.run(input);
        expect(result.exitCode).toBe(0);

        // install:true came from config — the cached install ran before the
        // command, which is the whole point (a suite needs its deps).
        const commands = handles.sandbox.execs.map((e) => e.command);
        expect(commands).toContain("pnpm install --frozen-lockfile");

        // timeoutSec:1800 came from config, not the 600s default — the other
        // half of the pair, since a suite that needs an install outruns 600s.
        const testExec = handles.sandbox.execs.find((e) => e.command === "pnpm test");
        expect(testExec?.timeoutSec).toBe(1800);

        // ...and the STEP wrapping that exec carries that ceiling plus the
        // headroom, so the exec's own deadline fires first (a clean
        // `ExecTimeout` with a log) rather than the platform killing both at
        // the same instant (`WorkflowTimeoutError`, empty artifact).
        //
        // Two timeouts, and only one of them was being set. A Workflow step
        // defaults to 600s, so a repo configuring 1800 got
        // `WorkflowTimeoutError: Execution timed out after 600000ms` at ten
        // minutes — from a limit its config never mentions, with an empty log
        // because the step died rather than the command. The assertion above
        // passed throughout: it only ever proved the inner half.
        const execStep = handles.executions.steps.find((s) => s.name === "exec");
        expect(execStep?.metadata?.["stepOpts.timeoutSec"]).toBe(1800 + 120);

        // ...and the step must NOT be replayed on failure: CF's default
        // `limit: 5` turns one wedged 30-minute exec into six attempts over
        // three hours, each replay re-entering the run body from the top.
        expect(execStep?.metadata?.["stepOpts.retries"]).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("webhook exec options — an explicit dispatch value beats CONFIG_KV", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "pnpm test": { exitCode: 0 } },
      config: {
        "offload-test.install:owner/name": "true",
        "offload-test.timeoutSec:owner/name": "1800",
      },
    });

    return Effect.gen(function* () {
      yield* offloadTest.run({
        ...baseInput,
        install: false,
        timeoutSec: 120,
      });
      // `install: false` is now distinguishable from "unset" — the whole
      // reason the schema default was removed — so config must NOT win.
      expect(handles.sandbox.execs.map((e) => e.command)).not.toContain(
        "pnpm install --frozen-lockfile",
      );
      expect(handles.sandbox.execs.find((e) => e.command === "pnpm test")?.timeoutSec).toBe(120);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "webhook exec options — no config and no dispatch value keeps the historical defaults",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
        config: { "offload-test.command:owner/name": "pnpm test" },
      });

      return Effect.gen(function* () {
        yield* offloadTest.run({
          repo: "owner/name",
          sha: "abc123",
          secrets: [] as readonly string[],
          failOnNonZeroExit: true,
        });
        // Unchanged from before this feature: no install, 600s.
        expect(handles.sandbox.execs.map((e) => e.command)).not.toContain(
          "pnpm install --frozen-lockfile",
        );
        expect(handles.sandbox.execs.find((e) => e.command === "pnpm test")?.timeoutSec).toBe(600);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "webhook exec options — a malformed config value degrades to the default, never NaN",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
        config: {
          "offload-test.command:owner/name": "pnpm test",
          "offload-test.install:owner/name": "yes-please",
          "offload-test.timeoutSec:owner/name": "half an hour",
        },
      });

      return Effect.gen(function* () {
        yield* offloadTest.run({
          repo: "owner/name",
          sha: "abc123",
          secrets: [] as readonly string[],
          failOnNonZeroExit: true,
        });
        // A typo'd timeout must not reach sandbox.exec as NaN — that is a
        // timeout that never fires, i.e. a hung run holding a container.
        expect(handles.sandbox.execs.find((e) => e.command === "pnpm test")?.timeoutSec).toBe(600);
        expect(handles.sandbox.execs.map((e) => e.command)).not.toContain(
          "pnpm install --frozen-lockfile",
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it("webhook trigger — omits install so CONFIG_KV can supply it", () => {
    const inputs = offloadTest.triggers?.[0]?.inputs?.({
      payload: {
        repository: { full_name: "owner/name" },
        pull_request: {
          draft: false,
          user: { login: "a-human" },
          head: { sha: "0123456789abcdef" },
        },
      },
    } as never) as Record<string, unknown> | undefined;

    // Restating `install: false` here would read as an explicit caller choice
    // and shadow `offload-test.install:<repo>` — the exact bug this guards.
    expect(inputs && "install" in inputs).toBe(false);
    expect(inputs && "timeoutSec" in inputs).toBe(false);
    // `secrets` stays pinned empty — a PR-triggered dispatch carries no creds.
    expect(inputs?.["secrets"]).toEqual([]);
  });

  it.effect(
    "secrets — Worker secret values are injected into the exec env, per-dispatch env wins",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
        secrets: {
          SOME_API_KEY: "key_from_worker",
          SOME_BASE_URL: "https://store.example.com",
        },
      });
      const input = {
        ...baseInput,
        secrets: ["SOME_API_KEY", "SOME_BASE_URL"],
        // Collides with the Worker secret — the per-dispatch value (the
        // more specific source) must win.
        env: { SOME_BASE_URL: "https://dispatch.example.com" },
      };

      return Effect.gen(function* () {
        const result = yield* offloadTest.run(input);
        expect(result.exitCode).toBe(0);

        const exec = handles.sandbox.execs.find((e) => e.command === "pnpm test");
        expect(exec?.env).toEqual({
          SOME_API_KEY: "key_from_worker",
          SOME_BASE_URL: "https://dispatch.example.com",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "secrets — a named-but-unset secret fails the run with SecretsMissing before the exec",
    () => {
      // No `config` seed — the named secret resolves to nothing. `loadSecrets`
      // runs with `required: true`, so the run fails fast instead of executing
      // the command without the credential.
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
      });
      const input = { ...baseInput, secrets: ["SOME_API_KEY"] };

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(offloadTest.run(input));

        expect(Exit.isFailure(exit)).toBe(true);
        const tag = Exit.isFailure(exit)
          ? Option.match(Cause.failureOption(exit.cause), {
              onSome: (f) => (f as { _tag?: string })._tag,
              onNone: () => undefined,
            })
          : undefined;
        expect(tag).toBe("SecretsMissing");

        // Fail-fast: the command never ran.
        expect(handles.sandbox.execs).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  // --- Pure webhook mode (specs/04-gha-integration.md § Pure webhook mode) ----

  // A minimal `pull_request` webhook payload — the standard fields the trigger
  // reads (`repository.full_name`, `pull_request.head.sha`, draft/user gates).
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
    const trigger = offloadTest.triggers?.[0];
    expect(trigger?.event).toBe("pull_request");
    expect(trigger?.actions).toContain("synchronize");

    const ctx = { payload: prPayload() };
    // command / install / timeoutSec all omitted — resolved from CONFIG_KV in
    // the body. `install` must NOT be restated: doing so reads as an explicit
    // caller choice and shadows `offload-test.install:<repo>`. fail-on-nonzero
    // is forced on so a red suite turns the check red; `secrets` stays pinned
    // empty because a PR-triggered dispatch must never carry credentials.
    expect(trigger?.inputs(ctx)).toEqual({
      repo: "owner/name",
      sha: "abcdef0123456789cafe",
      failOnNonZeroExit: true,
      secrets: [],
    });
    // instanceId mirrors Action mode's `{run}:{repo_}:{sha12}`.
    expect(trigger?.idempotencyKey(ctx)).toBe("offload-test:owner_name:abcdef012345");
  });

  it("webhook trigger — gate skips drafts and dependabot, admits real PRs", () => {
    const gate = offloadTest.triggers?.[0]?.gate;
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

  it.effect(
    "command resolution — a dispatch without `command` resolves it from CONFIG_KV (per-repo wins over the default)",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "cargo test --workspace": { exitCode: 0 } },
        config: {
          // Per-repo key wins over the dispatcher-wide default.
          "offload-test.command:owner/name": "cargo test --workspace",
          "offload-test.command": "pnpm test",
        },
      });
      // No `command` — webhook-shaped input.
      const input = {
        repo: "owner/name",
        sha: "abc123",
        secrets: [] as readonly string[],
        install: false,
        failOnNonZeroExit: false,
      };

      return Effect.gen(function* () {
        const result = yield* offloadTest.run(input);
        expect(result.exitCode).toBe(0);

        // The resolve-command step precedes the usual three.
        expect(handles.executions.steps.map((s) => s.name)).toEqual([
          "resolve-command",
          "checkout",
          "exec",
          "upload-log",
        ]);
        expect(handles.sandbox.execs.map((e) => e.command)).toContain("cargo test --workspace");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "command resolution — falls back to the dispatcher-wide `offload-test.command` when no per-repo key is set",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
        config: { "offload-test.command": "pnpm test" },
      });
      const input = {
        repo: "owner/name",
        sha: "abc123",
        secrets: [] as readonly string[],
        install: false,
        failOnNonZeroExit: false,
      };

      return Effect.gen(function* () {
        const result = yield* offloadTest.run(input);
        expect(result.exitCode).toBe(0);
        expect(handles.sandbox.execs.map((e) => e.command)).toContain("pnpm test");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "command resolution — no `command` and no CONFIG_KV fails fast with StepFailed before checkout",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
        // no `config` seed — neither command key resolves.
      });
      const input = {
        repo: "owner/name",
        sha: "abc123",
        secrets: [] as readonly string[],
        install: false,
        failOnNonZeroExit: false,
      };

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(offloadTest.run(input));
        expect(Exit.isFailure(exit)).toBe(true);
        const tag = Exit.isFailure(exit)
          ? Option.match(Cause.failureOption(exit.cause), {
              onSome: (f) => (f as { _tag?: string })._tag,
              onNone: () => undefined,
            })
          : undefined;
        expect(tag).toBe("StepFailed");
        // Fail-fast: never cloned, never exec'd.
        expect(handles.sandbox.clones).toHaveLength(0);
        expect(handles.sandbox.execs).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "failOnNonZeroExit — a non-zero exit fails the run with AcceptanceFailed (red check), carrying the exit code",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 2, stderr: "2 failing" } },
      });
      const input = { ...baseInput, failOnNonZeroExit: true };

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(offloadTest.run(input));

        expect(Exit.isFailure(exit)).toBe(true);
        const failure = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.failureOption(exit.cause))
          : undefined;
        expect((failure as { _tag?: string })?._tag).toBe("AcceptanceFailed");
        expect((failure as { exitCode?: number })?.exitCode).toBe(2);

        // The suite still ran end-to-end — the failure is the verdict, not a
        // skipped step. checkout → exec → upload-log all recorded.
        expect(handles.executions.steps.map((s) => s.name)).toEqual([
          "checkout",
          "exec",
          "upload-log",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "failOnNonZeroExit defaults off — Action-mode red path stays a successful Effect surfacing exitCode",
    () => {
      const { layer } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 1 } },
      });
      // baseInput carries no `failOnNonZeroExit` — the default-off path.
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(offloadTest.run(baseInput));
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) expect(exit.value.exitCode).toBe(1);
      }).pipe(Effect.provide(layer));
    },
  );

  // --- CI self-heal auto-dispatch (gated, specs/08-self-healing.md § 4) --------

  it.effect(
    "dispatches a ci-class self-heal-pr on a non-zero exit when self-heal.ci.enabled=true",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: {
          "pnpm test": { exitCode: 1, stdout: "FAIL: expected 2, got 3" },
        },
        config: { "self-heal.ci.enabled": "true" },
      });
      return Effect.gen(function* () {
        // failOnNonZeroExit defaults off ⇒ the Effect succeeds; the dispatch
        // happens before that gate, so it fires regardless of the check colour.
        yield* Effect.exit(offloadTest.run(baseInput));
        expect(handles.childRuns.spawned).toHaveLength(1);
        const spawn = handles.childRuns.spawned[0]!;
        expect(spawn.run).toBe("self-heal-pr");
        expect(spawn.instanceId).toContain("self-heal:ci:");
        const incident = (
          spawn.input as {
            incident: {
              class: string;
              repo: string;
              repro?: { command?: string };
            };
          }
        ).incident;
        expect(incident.class).toBe("ci");
        expect(incident.repo).toBe("owner/name");
        expect(incident.repro?.command).toBe("pnpm test");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("does NOT dispatch self-heal when the gate is unset", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "pnpm test": { exitCode: 1 } },
    });
    return Effect.gen(function* () {
      yield* Effect.exit(offloadTest.run(baseInput));
      expect(handles.childRuns.spawned).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does NOT dispatch self-heal on a green run even when enabled", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "pnpm test": { exitCode: 0 } },
      config: { "self-heal.ci.enabled": "true" },
    });
    return Effect.gen(function* () {
      yield* offloadTest.run(baseInput);
      expect(handles.childRuns.spawned).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});

// --- Source guard: no direct Date.now() / crypto.randomUUID() in the run -----
// A grep guard per specs/pm/plan.md § 6 — the run body must not introduce
// non-determinism; replay-sensitive values come from checkpointed step results
// (or `io`), so Workflow checkpoint replay is consistent.
describe("offload-test source determinism", () => {
  it.effect("the run body never calls Date.now()/crypto.randomUUID()", () =>
    Effect.sync(() => {
      const src = readFileSync(
        fileURLToPath(new URL("./offload-test.ts", import.meta.url)),
        "utf8",
      );
      // Strip line comments so a mention in a comment never trips the guard.
      const code = src.replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/\bDate\s*\.\s*now\b/);
      expect(code).not.toMatch(/\bcrypto\s*\.\s*randomUUID\b/);
      expect(code).not.toMatch(/\bMath\s*\.\s*random\b/);
    }),
  );
});
