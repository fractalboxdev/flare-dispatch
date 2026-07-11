// Run-level unit tests for the `worker-deploy` run.
//
// Exercises the run Effect against the in-memory test runtime
// (`makeCFRuntimeTest`) — no CF, no Docker, no network. Mirrors the
// offload-test suite; the run-specific cases are:
//
//   (a) green path      — deploy command exits 0 → `{ deployed: true }`
//   (b) not configured  — no `worker-deploy.command:<repo>` in the config
//                          store → no-op green (`deployed: false`,
//                          `skippedReason: "not-configured"`), nothing cloned
//                          or exec'd
//   (c) secrets         — env-var names resolve from
//                          `worker-deploy.secrets:<repo>` (+ prefix key) and
//                          the values are injected into the exec env
//   (d) missing secret  — a named-but-unset key fails with `SecretsMissing`
//                          before the exec
//   (e) red check       — `failOnNonZeroExit: true` (the webhook shape) turns
//                          a non-zero exit into `AcceptanceFailed`
//   (f) trigger mapping — the `check_suite.requested` payload maps to inputs;
//                          the gate admits only the default branch
//
// Plus the standard determinism source guard.
//
// Spec: specs/02-runs.md § worker-deploy, specs/03-dsl.md § Unit-testing runs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { workerDeploy } from "./worker-deploy";

const DEPLOY_CMD = "pnpm build && pnpm exec wrangler deploy";

const baseInput = {
  repo: "owner/name",
  sha: "abc123",
  command: DEPLOY_CMD,
  secrets: [] as readonly string[],
  install: false,
  failOnNonZeroExit: false,
} as const;

describe("worker-deploy", () => {
  it.effect("green path — deploy exits 0, output reports deployed: true", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
    });

    return Effect.gen(function* () {
      const result = yield* workerDeploy.run(baseInput);

      expect(result.deployed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.skippedReason).toBeUndefined();
      expect(typeof result.logUri).toBe("string");

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
    "webhook command resolution — resolves `worker-deploy.command:<repo>` from the config store",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
        config: { "worker-deploy.command:owner/name": DEPLOY_CMD },
      });
      // No `command` — webhook-shaped input.
      const input = {
        repo: "owner/name",
        sha: "abc123",
        secrets: [] as readonly string[],
        install: false,
        failOnNonZeroExit: true,
      };

      return Effect.gen(function* () {
        const result = yield* workerDeploy.run(input);
        expect(result.deployed).toBe(true);
        expect(handles.sandbox.execs.map((e) => e.command)).toContain(
          DEPLOY_CMD,
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "not configured — no per-repo command no-ops green: deployed false, nothing cloned or exec'd",
    () => {
      // No `config` seed and no `command` input — the repo never opted in.
      // The run must SUCCEED (green check) rather than fail every push of
      // every installed repo, and must not touch a container.
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
      });
      const input = {
        repo: "owner/name",
        sha: "abc123",
        secrets: [] as readonly string[],
        install: false,
        failOnNonZeroExit: true,
      };

      return Effect.gen(function* () {
        const result = yield* workerDeploy.run(input);

        expect(result.deployed).toBe(false);
        expect(result.skippedReason).toBe("not-configured");
        expect(result.logUri).toBeUndefined();
        expect(handles.sandbox.clones).toHaveLength(0);
        expect(handles.sandbox.execs).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "secrets — names from `worker-deploy.secrets:<repo>` (+ prefix key) resolve and inject into the exec env",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
        config: {
          "worker-deploy.command:owner/name": DEPLOY_CMD,
          "worker-deploy.secrets:owner/name":
            "CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID",
          "worker-deploy.secret-prefix:owner/name": "secret/",
          "secret/CLOUDFLARE_API_TOKEN": "cf_token_from_store",
          "secret/CLOUDFLARE_ACCOUNT_ID": "cf_account_from_store",
        },
      });
      const input = {
        repo: "owner/name",
        sha: "abc123",
        secrets: [] as readonly string[],
        install: false,
        failOnNonZeroExit: true,
      };

      return Effect.gen(function* () {
        const result = yield* workerDeploy.run(input);
        expect(result.deployed).toBe(true);

        const exec = handles.sandbox.execs.find(
          (e) => e.command === DEPLOY_CMD,
        );
        expect(exec?.env).toEqual({
          CLOUDFLARE_API_TOKEN: "cf_token_from_store",
          CLOUDFLARE_ACCOUNT_ID: "cf_account_from_store",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "secrets — a named-but-unset key fails with SecretsMissing before the exec",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
        config: {
          "worker-deploy.command:owner/name": DEPLOY_CMD,
          "worker-deploy.secrets:owner/name": "CLOUDFLARE_API_TOKEN",
          // the secret value itself is NOT seeded
        },
      });
      const input = {
        repo: "owner/name",
        sha: "abc123",
        secrets: [] as readonly string[],
        install: false,
        failOnNonZeroExit: true,
      };

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(workerDeploy.run(input));

        expect(Exit.isFailure(exit)).toBe(true);
        const tag = Exit.isFailure(exit)
          ? Option.match(Cause.failureOption(exit.cause), {
              onSome: (f) => (f as { _tag?: string })._tag,
              onNone: () => undefined,
            })
          : undefined;
        expect(tag).toBe("SecretsMissing");
        // Fail-fast: the deploy command never ran.
        expect(handles.sandbox.execs).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "failOnNonZeroExit — a failed deploy turns into AcceptanceFailed (red check) carrying the exit code",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: {
          [DEPLOY_CMD]: { exitCode: 1, stderr: "deploy failed" },
        },
      });
      const input = { ...baseInput, failOnNonZeroExit: true };

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(workerDeploy.run(input));

        expect(Exit.isFailure(exit)).toBe(true);
        const failure = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.failureOption(exit.cause))
          : undefined;
        expect((failure as { _tag?: string })?._tag).toBe("AcceptanceFailed");
        expect((failure as { exitCode?: number })?.exitCode).toBe(1);

        // The deploy ran end-to-end — the failure is the verdict, not a
        // skipped step.
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
    "failOnNonZeroExit defaults off — Action-mode red path stays a successful Effect surfacing exitCode",
    () => {
      const { layer } = makeCFRuntimeTest({
        sandboxProgram: { [DEPLOY_CMD]: { exitCode: 1 } },
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(workerDeploy.run(baseInput));
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
          expect(exit.value.deployed).toBe(false);
          expect(exit.value.exitCode).toBe(1);
        }
      }).pipe(Effect.provide(layer));
    },
  );

  // --- Webhook trigger — check_suite as the default-branch push signal --------

  const checkSuitePayload = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    action: "requested",
    repository: { full_name: "owner/name", default_branch: "main" },
    check_suite: {
      head_branch: "main",
      head_sha: "abcdef0123456789cafe",
    },
    ...overrides,
  });

  it("webhook trigger — maps the check_suite payload to inputs", () => {
    const trigger = workerDeploy.triggers?.[0];
    expect(trigger?.event).toBe("check_suite");
    expect(trigger?.actions).toEqual(["requested"]);

    const ctx = { payload: checkSuitePayload() };
    expect(trigger?.inputs(ctx)).toEqual({
      repo: "owner/name",
      sha: "abcdef0123456789cafe",
      branch: "main",
      failOnNonZeroExit: true,
      install: false,
      secrets: [],
    });
    expect(trigger?.idempotencyKey(ctx)).toBe(
      "worker-deploy:owner_name:abcdef012345",
    );
  });

  it("webhook trigger — gate admits only the repo's default branch", () => {
    const gate = workerDeploy.triggers?.[0]?.gate;
    expect(gate?.({ payload: checkSuitePayload() })).toBe(true);
    // Feature-branch push suites (PR lanes) never reach the deploy run.
    expect(
      gate?.({
        payload: checkSuitePayload({
          check_suite: {
            head_branch: "feat/thing",
            head_sha: "abcdef0123456789cafe",
          },
        }),
      }),
    ).toBe(false);
    // A repo whose default branch isn't `main` still gates correctly.
    expect(
      gate?.({
        payload: checkSuitePayload({
          repository: { full_name: "owner/name", default_branch: "trunk" },
          check_suite: {
            head_branch: "trunk",
            head_sha: "abcdef0123456789cafe",
          },
        }),
      }),
    ).toBe(true);
    // Malformed payload (no head_branch) is gated out, not dispatched.
    expect(
      gate?.({
        payload: checkSuitePayload({
          check_suite: { head_sha: "abcdef0123456789cafe" },
        }),
      }),
    ).toBe(false);
  });
});

// --- Source guard: no direct Date.now() / crypto.randomUUID() in the run -----
describe("worker-deploy source determinism", () => {
  it.effect("the run body never calls Date.now()/crypto.randomUUID()", () =>
    Effect.sync(() => {
      const src = readFileSync(
        fileURLToPath(new URL("./worker-deploy.ts", import.meta.url)),
        "utf8",
      );
      const code = src.replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/\bDate\s*\.\s*now\b/);
      expect(code).not.toMatch(/\bcrypto\s*\.\s*randomUUID\b/);
      expect(code).not.toMatch(/\bMath\s*\.\s*random\b/);
    }),
  );
});
