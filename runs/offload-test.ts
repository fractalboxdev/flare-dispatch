// `offload-test` — the FlareDispatch V0 walking-skeleton run.
//
// Clones a repo, runs a single command in a Sandbox container, uploads the
// command's log to R2, and returns the exit code + duration + log URL. This is
// the run the V0 acceptance criterion exercises: a `pnpm test` executing in CF
// Sandbox reporting green/red back to a PR check.
//
// Contract — inputs/outputs per specs/02-runs.md § 1. Body shape per
// specs/03-dsl.md § Top-level shape: `checkout → exec → upload-log`.
//
// --- Pure webhook mode (specs/04-gha-integration.md § Pure webhook mode) ------
//
// `offload-test` is also the *test* run for the zero-GHA path: its
// `pull_request` trigger fires the repo's suite on every PR with no
// `.github/workflows/` file and no GHA minutes, posting a green/red
// `flare-dispatch/offload-test` check that branch protection requires. Two
// generalizations make that work without disturbing the Action-mode contract:
//
//   * `command` is OPTIONAL. The trigger's `inputs` is a sync, payload-only
//     callback — it cannot read CONFIG_KV — so a webhook dispatch omits the
//     command and the run body resolves it from `offload-test.command:<repo>`
//     (per-repo) falling back to `offload-test.command` (dispatcher-wide). An
//     Action dispatch still passes `command` and skips the lookup entirely.
//   * `failOnNonZeroExit` flips a non-zero exit into a red check. In Action mode
//     the GHA step reads `exitCode`, so it stays false (a failing test is a
//     normal result — see note 2). Webhook mode has no GHA step to read it: the
//     check-run is the only signal, so the trigger sets it true and a non-zero
//     exit fails the Effect with `AcceptanceFailed`.
//
// --- Three design decisions, documented inline -------------------------------
//
// 1. No `finalize` step in the run body.
//    specs/02-runs.md § 1 lists the steps as `checkout → exec → upload-log →
//    finalize`, but `finalize` is *not* a run-body concern: it is the D1
//    `executions`-row status write and the GitHub check-run callback, both of
//    which are runtime/Workflow plumbing, not run logic. The `RunWorkflow`
//    class (PR4) owns that boundary — it maps the run's terminal Exit to the
//    `executions` status + the check-run conclusion *after* the run Effect
//    returns. Keeping `finalize` out of the run body keeps the run pure,
//    portable, and testable against `CFRuntimeTest` with no Checks/Executions
//    assertions. The run-body steps are therefore exactly the three from
//    specs/03-dsl.md § Top-level shape.
//
// 2. `durationMs` comes from the `exec` step's `ExecResult` — `result.durationMs`.
//    This is what specs/03-dsl.md § Top-level shape sketches, and it is the
//    replay-safe source: only `step(...)` results are checkpointed/memoized by
//    the CF Workflow, so on replay `result` is restored from the checkpoint
//    identically. Anything read *outside* a step (e.g. an `io.now` in the run
//    body) re-executes on every replay and would yield a fresh value — not
//    replay-deterministic. Sourcing `durationMs` from the checkpointed exec
//    result keeps the run's output stable across replays. No `Date.now()` /
//    `crypto.randomUUID()` is called in the run body.
//
// 3. Credentials come from the config store via `loadSecrets`, never the
//    dispatch body. The `env` input is for non-sensitive values only: dispatch
//    inputs are persisted (the `executions` row, Workflow params), so a secret
//    riding `env` would sit in storage at rest. A command that needs
//    credentials names config-store keys in `secrets` (+ `secretPrefix`) and
//    the run resolves them with `loadSecrets({ required: true })` — same
//    contract as `cdp-acceptance` (see its header note 1). `loadSecrets` is
//    called INLINE, not in a `step(...)`: step results are checkpointed to
//    durable Workflow storage, and plaintext credentials must not land there
//    either. The config read is cheap + idempotent to re-run on replay.
//
// Spec: specs/02-runs.md § 1, specs/03-dsl.md § Top-level shape + § sandbox,
//       specs/pm/plan.md § PR3.

import { Cause, Effect, Schema } from "effect";
import {
  AcceptanceFailed,
  artifact,
  commandFailureToIncident,
  config,
  defineRun,
  io,
  sandbox,
  spawnChildRun,
  StepFailed,
  step,
} from "@fractalboxdev/flare-dispatch-core";
import { loadSecrets, workspace } from "@fractalboxdev/flare-dispatch-core/primitives";

/** Input contract — specs/02-runs.md § 1. */
const OffloadTestInput = Schema.Struct({
  repo: Schema.String, // "owner/name"
  sha: Schema.String,
  /**
   * The command to run, e.g. `pnpm test` / `cargo test --workspace`. OPTIONAL:
   * a webhook-mode dispatch omits it (the `pull_request` trigger can't read
   * config) and the run body resolves it from CONFIG_KV — see `COMMAND_KEY`.
   */
  command: Schema.optional(Schema.String),
  image: Schema.optional(Schema.String), // override container image
  /**
   * Run the R2-cached dependency install (`installCached`: lockfile-detected
   * tool, content-addressed restore) after the clone, so the command doesn't
   * have to open with its own cold `pnpm install` / `npm ci` / `cargo fetch`.
   *
   * Plain `optional`, NOT
   * `optionalWith({default: false})`: a schema default is applied at decode, so
   * the body could never tell "caller explicitly chose false" from "caller said
   * nothing" — and that distinction is what lets a webhook dispatch fall through
   * to `offload-test.install:<repo>`. The false default now lives in the body's
   * resolution chain instead, so the effective behaviour is unchanged for every
   * caller that passes a value.
   */
  install: Schema.optional(Schema.Boolean),
  /** Non-sensitive env only — dispatch inputs are persisted (header note 3). */
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  /**
   * Config-store keys whose values are injected — as env vars of the same
   * name — into the command's env. Empty when the command needs no
   * credentials. See `loadSecrets` + header note 3.
   */
  secrets: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
  /** Prefix prepended to each `secrets` key for the config lookup. */
  secretPrefix: Schema.optional(Schema.String),
  timeoutSec: Schema.optional(Schema.Number), // default 600
  /**
   * Fail the run Effect (→ red `flare-dispatch/offload-test` check-run) when the
   * command exits non-zero. Default false preserves the V0 Action-mode contract:
   * a failing test is a normal `ExecResult` surfaced as `exitCode`, and the GHA
   * step reads it (see header note 2). Webhook mode has no GHA step, so its
   * `pull_request` trigger sets this true — the check-run is the only pass/fail
   * signal, so a non-zero exit must turn it red.
   */
  failOnNonZeroExit: Schema.optionalWith(Schema.Boolean, {
    default: () => false,
  }),
});

/** Output contract — specs/02-runs.md § 1. */
const OffloadTestOutput = Schema.Struct({
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  logUri: Schema.String, // signed R2 URL to the step log
});

/** Default `exec` timeout when the caller omits `timeoutSec`. */
const TIMEOUT_SEC_DEFAULT = 600;

/**
 * CONFIG_KV keys the run body resolves the command from when a dispatch carries
 * no `command` (webhook mode — the `pull_request` trigger's `inputs` is a sync,
 * payload-only callback that can't read config). The per-repo key wins over the
 * dispatcher-wide default, so one dispatcher serves repos with different test
 * commands: `wrangler kv key put --binding=CONFIG_KV "offload-test.command:owner/repo" "cargo test --workspace"`.
 */
const COMMAND_KEY = "offload-test.command";
const repoCommandKey = (repo: string): string => `offload-test.command:${repo}`;

/**
 * Per-repo CONFIG_KV overrides for the two knobs a webhook dispatch cannot
 * supply. Same reason `command` needs a key: a trigger's `inputs` is a sync,
 * payload-only callback, so anything it cannot compute from the PR payload has
 * to be resolvable in the run body.
 *
 * Without these, webhook mode is pinned to `install: false` and a 600s timeout,
 * which is fine for a source-only command and unusable for the case this run
 * exists to serve — running a repo's actual test suite, which needs its
 * dependency tree and routinely outruns ten minutes. The two are a pair: a
 * suite that needs an install almost always needs the longer ceiling too.
 *
 *   wrangler kv key put --binding=CONFIG_KV "offload-test.install:owner/repo" "true"
 *   wrangler kv key put --binding=CONFIG_KV "offload-test.timeoutSec:owner/repo" "1800"
 *
 * An explicit dispatch value always wins; these only fill the gap the trigger
 * leaves. `timeoutSec` is still clamped by the run's `maxDurationSec`.
 */
const repoInstallKey = (repo: string): string => `offload-test.install:${repo}`;
const repoTimeoutKey = (repo: string): string => `offload-test.timeoutSec:${repo}`;

/** `"true"`/`"1"` → true, `"false"`/`"0"` → false, anything else → undefined. */
const parseBoolConfig = (raw: string | undefined): boolean | undefined => {
  const v = raw?.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
};

/**
 * A positive integer, or `undefined` for absent/garbage. Deliberately does NOT
 * fall back to the default on a malformed value's behalf — the caller does that,
 * so a typo'd key degrades to the documented default rather than to `NaN`, which
 * would reach `sandbox.exec` as a timeout that never fires.
 */
const parseIntConfig = (raw: string | undefined): number | undefined => {
  const n = Number(raw?.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

export const offloadTest = defineRun({
  name: "offload-test",
  version: "1.1.0",

  // Webhook-mode trigger — the zero-GHA test path (specs/04-gha-integration.md
  // § Pure webhook mode). Fires the repo's suite on every PR push; the run body
  // resolves the command from CONFIG_KV (`command` is omitted here because this
  // callback is sync + payload-only). `failOnNonZeroExit: true` because the
  // check-run is the ONLY pass/fail signal in this mode.
  triggers: [
    {
      event: "pull_request",
      actions: ["opened", "synchronize", "reopened", "ready_for_review"],
      // Mirror Action mode's semantic instanceId (`{run}:{repo_}:{sha12}`) so a
      // webhook- and an Action-mode dispatch of the same commit collapse to one
      // execution at `create({id})` — same convention as pr-review.
      idempotencyKey: ({ payload }) =>
        `offload-test:${String(payload.repository?.full_name ?? "unknown/unknown").replace(
          /\//g,
          "_",
        )}:${String(payload.pull_request?.head?.sha ?? "").slice(0, 12)}`,
      // Skip drafts (not ready to gate) and dependabot (shouldn't burn container
      // minutes) — mirrors pr-review's gate.
      gate: ({ payload }) =>
        payload.pull_request?.draft !== true &&
        payload.pull_request?.user?.login !== "dependabot[bot]",
      inputs: ({ payload }) => ({
        repo: String(payload.repository?.full_name ?? "unknown/unknown"),
        sha: String(payload.pull_request?.head?.sha ?? ""),
        // command / install / timeoutSec omitted — all three resolved from
        // CONFIG_KV in the run body. `install` in particular MUST stay omitted:
        // restating it here would look like an explicit caller choice and take
        // precedence over `offload-test.install:<repo>`, which is exactly the
        // override webhook mode has no other way to express.
        failOnNonZeroExit: true,
        // `secrets` keeps its schema default restated — a PR-triggered dispatch
        // must never carry credentials, so pinning it empty here is deliberate.
        secrets: [],
      }),
    },
  ],

  inputs: OffloadTestInput,
  outputs: OffloadTestOutput,

  limits: {
    // Wall-time ceiling — specs/02-runs.md § 1. Single container, no
    // concurrency parameter.
    maxDurationSec: 1800,
  },

  run: (input) =>
    Effect.gen(function* () {
      // resolve-command — webhook-mode dispatches omit `command`; resolve it
      // from CONFIG_KV (`offload-test.command:<repo>` then the dispatcher-wide
      // `offload-test.command`). This step runs ONLY when the dispatch carried
      // no command, so Action-mode dispatches keep the exact
      // `checkout → exec → upload-log` step shape (the `??` short-circuits before
      // the `yield*`). A command missing everywhere fails fast — running an empty
      // command would post a meaningless green check.
      // `install` / `timeoutSec` are resolved INSIDE this same step, not a
      // second one. They are a webhook-mode concern, and webhook mode is
      // exactly the case that omits `command` — so folding them in here means
      // an Action dispatch (which passes `command`) still skips the whole thing
      // and keeps the historical `checkout → exec → upload-log` step shape that
      // the suite pins. One step, one checkpoint, no new config reads for
      // callers that supply everything.
      const resolved =
        input.command === undefined
          ? yield* step("resolve-command", () =>
              Effect.gen(function* () {
                const perRepo = yield* config.get(repoCommandKey(input.repo));
                const command =
                  perRepo !== undefined && perRepo.trim().length > 0
                    ? perRepo
                    : yield* config.get(COMMAND_KEY);
                return {
                  command,
                  install: parseBoolConfig(yield* config.get(repoInstallKey(input.repo))),
                  timeoutSec: parseIntConfig(yield* config.get(repoTimeoutKey(input.repo))),
                };
              }),
            )
          : {
              command: input.command,
              install: undefined,
              timeoutSec: undefined,
            };
      const command = resolved.command;
      if (command === undefined || command.trim().length === 0) {
        return yield* Effect.fail(
          new StepFailed({
            step: "resolve-command",
            cause:
              `offload-test: no command — pass \`command\` in the dispatch or set ` +
              `CONFIG_KV \`${repoCommandKey(input.repo)}\` or \`${COMMAND_KEY}\``,
          }),
        );
      }

      // Dispatch value → CONFIG_KV → documented default. The `false` here is the
      // schema default that used to live on the input (see its doc comment), so
      // a caller that passes nothing anywhere lands exactly where it always did.
      const install = input.install ?? resolved.install ?? false;
      const timeoutSec = input.timeoutSec ?? resolved.timeoutSec ?? TIMEOUT_SEC_DEFAULT;

      // checkout — acquire a container (honouring the `image` override), clone
      // the repo at the requested SHA, and optionally run the R2-cached
      // dependency install. One primitive, same opening move as cdp-acceptance.
      const { container, dir } = yield* step("checkout", () =>
        workspace({
          repo: input.repo,
          sha: input.sha,
          image: input.image,
          install,
        }),
      );

      // load-secrets — resolve the named credentials from the config store
      // into the env injected below. Called INLINE, not in a `step`: secrets
      // must not land in a durable Workflow checkpoint (see header note 3).
      // A no-op (empty record) when `secrets` is empty.
      const secretEnv = yield* loadSecrets(input.secrets, {
        prefix: input.secretPrefix,
        required: true,
      });

      // exec — run the command. A non-zero exit code is a NORMAL ExecResult
      // (a failing test), surfaced to the output below — never an Effect
      // failure. `sandbox.exec` fails its Effect only with ExecFailed /
      // ExecTimeout, which propagate out of the run unchanged. `result` is the
      // checkpointed step output — replay restores it identically, which is
      // why the run's `durationMs` is read from it (see header note 2).
      // The STEP carries the same ceiling as the exec inside it.
      //
      // There are two timeouts and they are not the same one. `timeoutSec`
      // below bounds the command; the Workflow step wrapping it has its own,
      // defaulting to 600s. Leave the step's unset and the lower ceiling wins
      // silently: a repo configuring `offload-test.timeoutSec = 1800` gets
      // `WorkflowTimeoutError: Execution timed out after 600000ms` at ten
      // minutes, from a limit nothing in its config mentions, and the artifact
      // is empty because the step died rather than the command.
      //
      // So the step timeout is DERIVED from the exec timeout rather than
      // configured beside it — two knobs that must agree are one knob with a
      // bug in it. `maxDurationSec` still clamps the whole run above both.
      const result = yield* step(
        "exec",
        () =>
          sandbox.exec({
            cwd: dir,
            container,
            command,
            // Per-dispatch `env` wins over a same-named config-store secret —
            // the more specific source overrides the global one.
            env: { ...secretEnv, ...input.env },
            timeoutSec,
          }),
        { timeoutSec },
      );

      // upload-log — push the captured stdout/stderr to R2, get a signed URL.
      // No `container` here: `result.logPath` is the R2 object key the live
      // sandbox exec streamed the log to (artifact-r2.ts "R2-source-key mode"),
      // not a container filesystem path.
      const logUri = yield* step("upload-log", () =>
        artifact.upload({
          name: "step.log",
          path: result.logPath,
          signedUrlTTL: "30 days",
        }),
      );

      // self-heal — (gated, OFF unless `self-heal.ci.enabled=true`) auto-dispatch
      // a fix for a DETERMINISTIC CI failure. Unlike the LLM-driven demo verdict
      // (which needs k-of-n confirmation), a non-zero exit IS ground truth — the
      // command is the deterministic oracle, so one failed command escalates
      // directly. One `ci`-class incident → one child `self-heal-pr`, deduped on
      // `{repo, sha}` so re-runs of the same commit collapse to a single heal (a
      // new push re-heals). Per-heal model spend is bounded by the AgentBudget DO.
      // Best-effort throughout — a dispatch fault never changes this run's check
      // outcome. specs/08-self-healing.md § 4 (ci class) + § 9 (dedup).
      if (result.exitCode !== 0 && (yield* config.get("self-heal.ci.enabled")) === "true") {
        const incident = commandFailureToIncident({
          repo: input.repo,
          sha: input.sha,
          command,
          exitCode: result.exitCode,
          logTail: result.stdout,
          logUri,
        });
        if (incident !== null) {
          yield* step("dispatch-self-heal", () =>
            spawnChildRun({
              run: "self-heal-pr",
              input: { incident },
              instanceId: `self-heal:${incident.incidentId}:${input.sha}`.slice(0, 200),
            }),
          ).pipe(
            Effect.flatMap((handle) =>
              io.log(
                "info",
                `offload-test: dispatched self-heal-pr ${handle.executionId} for ${input.repo}@${input.sha.slice(0, 12)}${handle.created ? "" : " (deduped — already dispatched)"}`,
              ),
            ),
            Effect.catchAllCause((cause) =>
              io.log(
                "warn",
                `offload-test: self-heal dispatch failed (best-effort) — ${Cause.pretty(cause).slice(0, 400)}`,
              ),
            ),
          );
        }
      }

      // fail-on-nonzero — webhook mode (no GHA job reads the exit code) flips a
      // non-zero exit into a red check via a typed `AcceptanceFailed` carrying
      // the log link, which the dispatcher renders under the failure summary
      // (issue #85). Action mode leaves the flag false: a failing test stays a
      // normal result surfaced as `exitCode` (the V0 contract, header note 2).
      if (input.failOnNonZeroExit && result.exitCode !== 0) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: result.exitCode,
            summaryMd: [
              `Command \`${command}\` exited \`${result.exitCode}\`.`,
              "",
              `[View full test log ↗](${logUri})`,
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
