// `check` — the universal, opt-in command gate.
//
// Catalog counterpart of `oxlint` for clients who do not want Oxc. Same
// PR-gate role (clone → run one command → upload log → green/red
// `flare-dispatch/check`), but the command is free-form: `pnpm lint`,
// `npx eslint .`, `npx biome check .`, `cargo clippy --workspace`, etc.
//
// `oxlint` stays the install-free, hardcoded Oxc gate — droppable on any
// JS/TS repo with no opt-in. `check` is the gate when the client picks
// their own tool, and therefore MUST opt in.
//
// --- Opt-out by default (worker-deploy shape) ---------------------------------
//
// A webhook trigger fires for EVERY installed repo's PR push, and its `gate`
// is sync + payload-only — it cannot ask the config store whether the repo
// opted in. So opt-in is resolved in the run body: no
// `check.command:<owner/repo>` in CONFIG_KV → the run returns
// `{ exitCode: 0, skippedReason: "not-configured" }` and the check stays
// green. There is deliberately NO dispatcher-wide command fallback (unlike
// `offload-test`): a global default would turn every installed repo's PRs
// into a lint storm.
//
// --- Credentials --------------------------------------------------------------
//
// Same contract as `offload-test` header note 3: secret *names* ride the
// dispatch / config surface, never plaintext values. `loadSecrets` resolves
// Worker secret bindings INLINE (not in a `step`) so credentials never land
// in a durable Workflow checkpoint. Per-dispatch `env` wins over a same-named
// secret. See `runs/README.md`.
//
// Determinism: `durationMs` comes from the checkpointed `ExecResult`; the
// body calls no `Date.now()` / `crypto.randomUUID()`.

import { Effect, Schema } from "effect";
import {
  AcceptanceFailed,
  artifact,
  config,
  defineRun,
  io,
  sandbox,
  step,
} from "@fractalboxdev/flare-dispatch-core";
import { loadSecrets, workspace } from "@fractalboxdev/flare-dispatch-core/primitives";

const CheckInput = Schema.Struct({
  repo: Schema.String, // "owner/name"
  sha: Schema.String,
  /**
   * The check command, e.g. `pnpm lint` / `npx eslint .` / `cargo clippy`.
   * OPTIONAL: a webhook-mode dispatch omits it and the run body resolves
   * `check.command:<owner/repo>` from CONFIG_KV. No per-repo key → the run
   * no-ops green (see header).
   */
  command: Schema.optional(Schema.String),
  image: Schema.optional(Schema.String), // container image override
  /** Run the R2-cached dependency install after the clone. */
  install: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  /**
   * Non-sensitive env only. Dispatch inputs are persisted (executions row +
   * Workflow params) — never put credentials here. Same contract as
   * `offload-test` / `worker-deploy`; see `runs/README.md`.
   */
  env: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
  /**
   * Config-store / Worker-secret keys whose values are injected — as env vars
   * of the same name — into the command's env. Empty when the command needs
   * no credentials. See `loadSecrets` + header.
   */
  secrets: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
  /**
   * @deprecated Ignored by `loadSecrets` (Worker bindings are bare names).
   * Kept so Action inputs / call sites match `offload-test`.
   */
  secretPrefix: Schema.optional(Schema.String),
  timeoutSec: Schema.optional(Schema.Number), // default 600
  /**
   * Fail the run Effect (→ red `flare-dispatch/check` check) on a non-zero
   * exit. Webhook mode sets this true — the check-run is the only signal.
   * Action mode defaults false and reads `exitCode`, mirroring `offload-test`.
   */
  failOnNonZeroExit: Schema.optionalWith(Schema.Boolean, {
    default: () => false,
  }),
});

const CheckOutput = Schema.Struct({
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  /** Signed R2 URL to the check log. Absent when the run no-oped. */
  logUri: Schema.optional(Schema.String),
  /** Why the run no-oped (e.g. "not-configured"). Absent when the command ran. */
  skippedReason: Schema.optional(Schema.String),
});

/** Decoded input — pin trigger `inputs` to this so `defineRun` does not infer `I` from the narrower webhook return. */
type CheckI = Schema.Schema.Type<typeof CheckInput>;

/** Default `exec` timeout — lint is usually fast; install + slow tools get headroom via `timeoutSec`. */
const DEFAULT_TIMEOUT_SEC = 600;

/** CONFIG_KV key — strictly per-repo (see header: no global fallback). */
const commandKey = (repo: string): string => `check.command:${repo}`;

export const check = defineRun({
  name: "check",
  version: "1.0.0",

  inputs: CheckInput,
  outputs: CheckOutput,

  // Webhook-mode trigger — the zero-GHA check gate. Fires on every PR push;
  // the run body resolves the command from CONFIG_KV (`command` is omitted
  // here because this callback is sync + payload-only). Unconfigured repos
  // no-op green. `failOnNonZeroExit: true` because the check-run is the only
  // pass/fail signal. Gate mirrors oxlint / offload-test: skip drafts +
  // dependabot.
  triggers: [
    {
      event: "pull_request",
      actions: ["opened", "synchronize", "reopened", "ready_for_review"],
      idempotencyKey: ({ payload }) =>
        `check:${String(
          payload.repository?.full_name ?? "unknown/unknown",
        ).replace(/\//g, "_")}:${String(
          payload.pull_request?.head?.sha ?? "",
        ).slice(0, 12)}`,
      gate: ({ payload }) =>
        payload.pull_request?.draft !== true &&
        payload.pull_request?.user?.login !== "dependabot[bot]",
      // Annotated return type — without it, `defineRun` infers `I` from this
      // object literal and drops optional fields (`command`, `image`, …).
      inputs: ({ payload }): CheckI => ({
        repo: String(payload.repository?.full_name ?? "unknown/unknown"),
        sha: String(payload.pull_request?.head?.sha ?? ""),
        // command omitted — resolved from CONFIG_KV in the run body.
        failOnNonZeroExit: true,
        // Decoded-shape defaults the trigger return must restate.
        install: false,
        secrets: [],
      }),
    },
  ],

  limits: {
    // Wall-time ceiling — headroom for cold install + slow linters.
    maxDurationSec: 1800,
  },

  run: (input) =>
    Effect.gen(function* () {
      // resolve-config — the per-repo check command. Missing → the repo hasn't
      // opted in; no-op green rather than failing every PR of every installed
      // repo.
      const command = yield* step("resolve-config", () =>
        Effect.gen(function* () {
          return input.command ?? (yield* config.get(commandKey(input.repo)));
        }),
      );
      if (command === undefined || command.trim().length === 0) {
        yield* io.log(
          "warn",
          `check: no \`${commandKey(input.repo)}\` in the config store — repo not opted in, skipping`,
        );
        return {
          exitCode: 0,
          durationMs: 0,
          skippedReason: "not-configured",
        };
      }

      // checkout — container + clone at the SHA (+ optional cached install).
      const { container, dir } = yield* step("checkout", () =>
        workspace({
          repo: input.repo,
          sha: input.sha,
          image: input.image,
          install: input.install,
        }),
      );

      // load-secrets — resolve named Worker secrets into the exec env. INLINE
      // (never in a step): plaintext must not land in checkpointed Workflow
      // state. No-op when `secrets` is empty. `required: true` — a named-but-
      // unset credential fails fast before the command runs.
      const secretEnv = yield* loadSecrets(input.secrets, {
        prefix: input.secretPrefix,
        required: true,
      });

      // exec — run the check command. A non-zero exit is a normal ExecResult
      // here; the failOnNonZeroExit branch below decides whether it reds the
      // check. `result` is the checkpointed step output — replay restores it
      // identically, which is why `durationMs` is read from it.
      const result = yield* step("exec", () =>
        sandbox.exec({
          cwd: dir,
          container,
          command,
          // Per-dispatch `env` wins over a same-named Worker secret.
          env: { ...secretEnv, ...input.env },
          timeoutSec: input.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
        }),
      );

      // upload-log — push the captured stdout/stderr to R2, get a signed URL.
      // 30-day TTL matches the catalog (`oxlint` / `offload-test` / …); operators
      // must not print secrets from the check command (see runs/README.md).
      const logUri = yield* step("upload-log", () =>
        artifact.upload({
          name: "check.log",
          path: result.logPath,
          signedUrlTTL: "30 days",
        }),
      );

      if (input.failOnNonZeroExit && result.exitCode !== 0) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: result.exitCode,
            summaryMd: [
              `\`${command}\` exited \`${result.exitCode}\` — check reported problems (or failed to run; see the log).`,
              "",
              `[View full check log ↗](${logUri})`,
            ].join("\n"),
          }),
        );
      }

      return {
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        logUri,
      };
    }),
});
