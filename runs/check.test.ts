// Run-level unit tests for the `check` run.
//
// Exercise the run Effect against the in-memory test runtime
// (`makeCFRuntimeTest`) — no CF, no Docker, no network. Covers:
//
//   (a) not configured — no `check.command:<repo>` → no-op green
//   (b) KV resolve     — webhook-shaped input resolves the per-repo command
//   (c) input wins     — explicit `command` skips needing KV
//   (d) green path     — exit 0 → output + four steps
//   (e) red path       — exit 1 + failOnNonZeroExit → AcceptanceFailed
//   (f) advisory       — failOnNonZeroExit off → successful Effect, exitCode 1
//   (g) install        — install:true runs cached dep install before command
//   (h) secrets        — Worker secrets inject into exec env; missing → SecretsMissing
//   (i) webhook trig   — PR payload maps to inputs; gate skips drafts/dependabot
//
// Plus the standard determinism source guard.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { check } from "./check";

const CHECK_CMD = "pnpm lint";

const baseInput = {
  repo: "owner/name",
  sha: "abc123",
  command: CHECK_CMD,
  install: false,
  secrets: [] as readonly string[],
  failOnNonZeroExit: false,
} as const;

describe("check", () => {
  it.effect(
    "not configured — no per-repo command no-ops green: nothing cloned or exec'd",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [CHECK_CMD]: { exitCode: 0 } },
      });
      const input = {
        repo: "owner/name",
        sha: "abc123",
        install: false,
        secrets: [] as readonly string[],
        failOnNonZeroExit: true,
      };

      return Effect.gen(function* () {
        const result = yield* check.run(input);

        expect(result.exitCode).toBe(0);
        expect(result.durationMs).toBe(0);
        expect(result.skippedReason).toBe("not-configured");
        expect(result.logUri).toBeUndefined();
        expect(handles.sandbox.clones).toHaveLength(0);
        expect(handles.sandbox.execs).toHaveLength(0);
        expect(handles.executions.steps.map((s) => s.name)).toEqual([
          "resolve-config",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "webhook command resolution — resolves `check.command:<repo>` from the config store",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [CHECK_CMD]: { exitCode: 0 } },
        config: { "check.command:owner/name": CHECK_CMD },
      });
      const input = {
        repo: "owner/name",
        sha: "abc123",
        install: false,
        secrets: [] as readonly string[],
        failOnNonZeroExit: true,
      };

      return Effect.gen(function* () {
        const result = yield* check.run(input);
        expect(result.exitCode).toBe(0);
        expect(result.skippedReason).toBeUndefined();
        expect(handles.sandbox.execs.map((e) => e.command)).toContain(
          CHECK_CMD,
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "input command wins — explicit command skips needing KV",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [CHECK_CMD]: { exitCode: 0 } },
        // KV has a different command — input must win.
        config: { "check.command:owner/name": "npx eslint ." },
      });

      return Effect.gen(function* () {
        const result = yield* check.run(baseInput);
        expect(result.exitCode).toBe(0);
        expect(handles.sandbox.execs.map((e) => e.command)).toContain(
          CHECK_CMD,
        );
        expect(handles.sandbox.execs.map((e) => e.command)).not.toContain(
          "npx eslint .",
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("green path — exit 0, four steps, log uploaded", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [CHECK_CMD]: { exitCode: 0, durationMs: 1234 } },
    });

    return Effect.gen(function* () {
      const result = yield* check.run(baseInput);

      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBe(1234);
      expect(result.skippedReason).toBeUndefined();
      expect(typeof result.logUri).toBe("string");
      expect(result.logUri!.length).toBeGreaterThan(0);

      expect(handles.executions.steps.map((s) => s.name)).toEqual([
        "resolve-config",
        "checkout",
        "exec",
        "upload-log",
      ]);
      expect(handles.sandbox.clones).toHaveLength(1);
      expect(handles.sandbox.clones[0]).toEqual({
        repo: "owner/name",
        sha: "abc123",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "red path — exit 1 with failOnNonZeroExit ON fails with AcceptanceFailed",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: {
          [CHECK_CMD]: { exitCode: 1, stderr: "1 error" },
        },
      });
      const input = { ...baseInput, failOnNonZeroExit: true };

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(check.run(input));

        expect(Exit.isFailure(exit)).toBe(true);
        const failure = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.failureOption(exit.cause))
          : undefined;
        expect((failure as { _tag?: string })?._tag).toBe("AcceptanceFailed");
        expect((failure as { exitCode?: number })?.exitCode).toBe(1);

        expect(handles.executions.steps.map((s) => s.name)).toEqual([
          "resolve-config",
          "checkout",
          "exec",
          "upload-log",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "advisory mode — failOnNonZeroExit off makes a finding a successful Effect",
    () => {
      const { layer } = makeCFRuntimeTest({
        sandboxProgram: { [CHECK_CMD]: { exitCode: 1 } },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(check.run(baseInput));
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) expect(exit.value.exitCode).toBe(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "install — runs the cached dependency install before the check command",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [CHECK_CMD]: { exitCode: 0 } },
      });
      const input = { ...baseInput, install: true, image: "custom/image:1" };

      return Effect.gen(function* () {
        const result = yield* check.run(input);
        expect(result.exitCode).toBe(0);

        expect(handles.sandbox.acquired[0]).toEqual({
          image: "custom/image:1",
        });

        const commands = handles.sandbox.execs.map((e) => e.command);
        expect(commands).toContain("pnpm install --frozen-lockfile");
        expect(commands.indexOf("pnpm install --frozen-lockfile")).toBeLessThan(
          commands.indexOf(CHECK_CMD),
        );

        // Install lives inside checkout — still four run steps.
        expect(handles.executions.steps.map((s) => s.name)).toEqual([
          "resolve-config",
          "checkout",
          "exec",
          "upload-log",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "secrets — Worker secret values are injected into the exec env, per-dispatch env wins",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [CHECK_CMD]: { exitCode: 0 } },
        secrets: {
          NPM_TOKEN: "token_from_worker",
          REGISTRY_URL: "https://store.example.com",
        },
      });
      const input = {
        ...baseInput,
        secrets: ["NPM_TOKEN", "REGISTRY_URL"],
        // Collides with the Worker secret — the per-dispatch value wins.
        env: { REGISTRY_URL: "https://dispatch.example.com" },
      };

      return Effect.gen(function* () {
        const result = yield* check.run(input);
        expect(result.exitCode).toBe(0);

        const exec = handles.sandbox.execs.find((e) => e.command === CHECK_CMD);
        expect(exec?.env).toEqual({
          NPM_TOKEN: "token_from_worker",
          REGISTRY_URL: "https://dispatch.example.com",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "secrets — a named-but-unset secret fails with SecretsMissing before checkout or exec",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [CHECK_CMD]: { exitCode: 0 } },
      });
      const input = { ...baseInput, secrets: ["NPM_TOKEN"] };

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(check.run(input));

        expect(Exit.isFailure(exit)).toBe(true);
        const tag = Exit.isFailure(exit)
          ? Option.match(Cause.failureOption(exit.cause), {
              onSome: (f) => (f as { _tag?: string })._tag,
              onNone: () => undefined,
            })
          : undefined;
        expect(tag).toBe("SecretsMissing");
        // Fail-fast: secrets resolve BEFORE checkout — neither the clone nor
        // the check command ran, so a misconfigured dispatch never pays for
        // provisioning a container it can't use.
        expect(handles.sandbox.clones).toHaveLength(0);
        expect(handles.sandbox.execs).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "log redaction — secret values are scrubbed from captured stdout/stderr",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: {
          [CHECK_CMD]: {
            exitCode: 0,
            stdout: "using token super-secret-value for install",
            stderr: "auth: super-secret-value",
          },
        },
        secrets: { NPM_TOKEN: "super-secret-value" },
      });
      const input = { ...baseInput, secrets: ["NPM_TOKEN"] };

      return Effect.gen(function* () {
        const result = yield* check.run(input);
        expect(result.exitCode).toBe(0);

        const exec = handles.sandbox.execs.find((e) => e.command === CHECK_CMD);
        expect(exec?.stdout).not.toContain("super-secret-value");
        expect(exec?.stderr).not.toContain("super-secret-value");
        expect(exec?.stdout).toContain("***");
        expect(exec?.stderr).toContain("***");
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
    const trigger = check.triggers?.[0];
    expect(trigger?.event).toBe("pull_request");
    expect(trigger?.actions).toContain("synchronize");

    const ctx = { payload: prPayload() };
    expect(trigger?.inputs(ctx)).toEqual({
      repo: "owner/name",
      sha: "abcdef0123456789cafe",
      failOnNonZeroExit: true,
      install: false,
      secrets: [],
    });
    expect(trigger?.idempotencyKey(ctx)).toBe("check:owner_name:abcdef012345");
  });

  it("webhook trigger — gate skips drafts and dependabot, admits real PRs", () => {
    const gate = check.triggers?.[0]?.gate;
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
describe("check source determinism", () => {
  it.effect("the run body never calls Date.now()/crypto.randomUUID()", () =>
    Effect.sync(() => {
      const src = readFileSync(
        fileURLToPath(new URL("./check.ts", import.meta.url)),
        "utf8",
      );
      const code = src.replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/\bDate\s*\.\s*now\b/);
      expect(code).not.toMatch(/\bcrypto\s*\.\s*randomUUID\b/);
      expect(code).not.toMatch(/\bMath\s*\.\s*random\b/);
    }),
  );
});
