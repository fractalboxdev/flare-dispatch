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
// --- Staged mode (`offload-test.stages:<repo>`) -------------------------------
//
// One 40–60-minute buffered exec is a single point of failure: when the
// platform kills the step (observed `WorkflowInternalError` at 8 min,
// `ExecTimeout` at 30 min), the buffered log dies with it and the check-run
// links a 404 artifact — the operator cannot tell a capacity failure from a
// broken build (issue #39). Setting `offload-test.stages:<repo>` to a
// comma-separated list of labels (e.g. "workspace,features,connectors,ts")
// splits the run into one exec step per stage:
//
//   * each stage runs `exec-<label>` with its own command
//     (`offload-test.command:<repo>:<label>`, falling back to the unlabelled
//     command — the labelled-rung ladder `check` v1.1.0 introduced) and its own
//     timeout (`offload-test.timeoutSec:<repo>:<label>` ?? the dispatch
//     `timeoutSec` ?? the unlabelled rung ?? default), step timeout derived
//     with the same headroom, `retries: 0`;
//   * each stage's log uploads as `step-<label>.log` IMMEDIATELY after the
//     stage, so a later stage dying cannot take an earlier stage's log with it;
//   * a stage that exits non-zero stops the sequence (later stages are
//     `set -e`-style dependents of earlier ones); a stage step that DIES
//     (timeout/internal/platform kill) gets a one-line marker uploaded under
//     its `step-<label>.log` name and the run fails naming the stage, the
//     ✓/✗/⊘ rundown riding `StepFailed.summaryMd` so the check-run renders
//     it as real markdown. The marker rides the marker exec's own R2 log
//     stream (see the upload step), so it lands on both sandbox backends.
//
// Staging makes earlier stages' logs DURABLE — it does not buy a long suite
// more wall time. Each stage runs under its own exec ceiling (the labelled /
// unlabelled `timeoutSec` rungs), and those per-exec ceilings are the only
// runtime enforcement there is: `limits.maxDurationSec` is validated at
// definition time and never read again at runtime. Size the stage ceilings to
// the suite; staging alone does not stretch them.
//
// Why sequential stages in ONE instance, not `matrix-fanout` + labelled
// `check` (separate instances, independent timeouts, parallel)? The stages
// are ordered dependents sharing one checkout — later stages assume earlier
// ones passed — and the repo gates on ONE `flare-dispatch/offload-test`
// check-run. Fanout buys parallelism an ordered suite cannot use, at the cost
// of N checkouts and N check-runs to re-aggregate.
//
// The key is resolved inside the same `resolve-command` step that reads the
// command, so staged mode exists only on the webhook path (a dispatch that
// passes `command` skips the step, exactly as before). ABSENT key → byte-
// identical behaviour to 1.1.0: one exec, one `step.log`, same step names.
// Instance id / dedup are UNCHANGED — stages are internal steps of one
// workflow instance posting one check-run. The dispatcher stays generic:
// stages are just labelled commands from KV, no repo-specific knowledge here.
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

import { Cause, Effect, Exit, Option, Schema } from "effect";
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
   *
   * @deprecated ADR-0006 — a value in the command's env is a long-lived
   * credential reachable from inside the container, and redaction only keeps it
   * out of the log. Migrate to worker-side writeback or to a grant profile whose
   * credential the substrate's egress handler attaches
   * (apps/substrate/specs/credential-boundary.md); removed at stage-2 exit.
   */
  secrets: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
  /**
   * Prefix prepended to each `secrets` key for the config lookup.
   *
   * @deprecated Ignored by `loadSecrets` (Worker bindings are bare names), and
   * removed with `secrets` at the substrate stage-2 exit (ADR-0006).
   */
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
 * Headroom added to the `exec` timeout to derive the Workflow STEP timeout, so
 * the sandbox's own deadline fires first (a clean `ExecTimeout` with the log
 * streamed so far) instead of the platform hard-killing the step at the same
 * instant (`WorkflowTimeoutError`, no log, nothing for `upload-log` to serve).
 * Same idea as playwright-demo's headroom, with one deliberate difference: NOT
 * clamped to `maxDurationSec`. At the documented `offload-test.timeoutSec =
 * 1800` config the clamp would collapse the headroom to zero — step and exec
 * expire together and the platform kill wins, which is exactly the failure
 * this exists to prevent.
 */
const STEP_TIMEOUT_HEADROOM_SEC = 120;

const PLATFORM_RETRIES = 1;

const RETRY_ON = ["ExecFailed"] as const;

const stepTimeoutFor = (execTimeoutSec: number): number =>
  execTimeoutSec * (PLATFORM_RETRIES + 1) + STEP_TIMEOUT_HEADROOM_SEC;

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
 * leaves. `timeoutSec` is enforced per exec by the sandbox's own deadline —
 * there is no additional runtime wall-clock clamp (`limits.maxDurationSec` is
 * a definition-time validation only).
 */
const repoInstallKey = (repo: string): string => `offload-test.install:${repo}`;
const repoTimeoutKey = (repo: string): string => `offload-test.timeoutSec:${repo}`;

/**
 * Staged-mode CONFIG_KV rungs (see header § Staged mode). The stages key holds
 * a comma-separated list of labels; each label may carry its own command and
 * timeout under the labelled rung, most specific first — same ladder shape as
 * `check.command:<repo>:<label>`:
 *
 *   wrangler kv key put --binding=CONFIG_KV "offload-test.stages:owner/repo" "workspace,features,ts"
 *   wrangler kv key put --binding=CONFIG_KV "offload-test.command:owner/repo:features" "pnpm test --filter features"
 *   wrangler kv key put --binding=CONFIG_KV "offload-test.timeoutSec:owner/repo:ts" "900"
 */
const repoStagesKey = (repo: string): string => `offload-test.stages:${repo}`;
const stageCommandKey = (repo: string, label: string): string => `${repoCommandKey(repo)}:${label}`;
const stageTimeoutKey = (repo: string, label: string): string => `${repoTimeoutKey(repo)}:${label}`;

/**
 * Legal stage label — same charset `check` enforces on `checkLabel`, for the
 * same reason: the label becomes a step name (`exec-<label>`) and a CONFIG_KV
 * key segment, so a stray `:`/space/emoji would produce keys and step names
 * that silently match nothing an operator typed. A malformed label fails the
 * resolve step loudly rather than degrading to a single exec — a typo'd stages
 * key that silently un-stages the run would resurrect exactly the
 * log-dies-with-the-step failure staging exists to fix.
 */
/**
 * Inner error classes worth recovering from a boundary-wrapped StepFailed's
 * rendered cause (see the errorClass recovery in staged mode). The typed tag
 * usually survives the step boundary intact; this covers the case where the
 * boundary eats it, where the class is usually still recoverable from the
 * rendered cause text (staging evidence: the same death read
 * `error=StepFailed` before this recovery, `error=ExecFailed` with it).
 * Anchored to the known tag vocabulary so vendor free text can never mint a
 * class — a pure platform error (`WorkflowInternalError`) contains none of
 * these words and falls back to `StepFailed`, the honest answer there.
 */
const INNER_EXEC_ERROR_RE = /\b(ExecTimeout|ExecFailed|CheckoutFailed)\b/;

const STAGE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/** One resolved stage — plain JSON, because it rides the checkpointed resolve-step result. */
type ResolvedStage = {
  readonly label: string;
  readonly command: string;
  /** labelled `offload-test.timeoutSec:<repo>:<label>` — absent falls through to the unlabelled chain. */
  readonly timeoutSec?: number | undefined;
  /**
   * True when the labelled command rung was missing and the stage fell back
   * to the unlabelled command. Suspicious when stages are declared (usually a
   * typo'd key), so it is warned at resolve and recorded on the stage's
   * exec-step metadata. Two stages MAY share a command (a repo staging one
   * command purely for the per-stage timeout and log split): the facade keys
   * an exec's identity on the enclosing STEP as well as the command (#86), so
   * `exec-a` and `exec-b` stay distinct executions on both backends.
   */
  readonly commandFellBack: boolean;
};

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
  // 1.2.0 — additive: staged mode (`offload-test.stages:<repo>` + the labelled
  // command/timeout rungs). No stages key → the 1.1.0 behaviour, byte-identical.
  version: "1.2.0",

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
    // concurrency parameter. Validated at definition time (define-run.ts);
    // the runtime enforcement a stage actually meets is its per-exec
    // `timeoutSec` ceiling — see header § Staged mode.
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
      const resolved: {
        command: string | undefined;
        install: boolean | undefined;
        timeoutSec: number | undefined;
        stages?: readonly ResolvedStage[] | undefined;
      } =
        input.command === undefined
          ? yield* step("resolve-command", () =>
              Effect.gen(function* () {
                const perRepo = yield* config.get(repoCommandKey(input.repo));
                const command =
                  perRepo !== undefined && perRepo.trim().length > 0
                    ? perRepo
                    : yield* config.get(COMMAND_KEY);
                const install = parseBoolConfig(yield* config.get(repoInstallKey(input.repo)));
                const timeoutSec = parseIntConfig(yield* config.get(repoTimeoutKey(input.repo)));

                // stages — resolved in this SAME step (not a new one) so the
                // unstaged step shape stays exactly what the suite pins, and so
                // staged mode exists only where the defect lives: the webhook
                // path, whose one buffered exec is the thing that dies. See
                // header § Staged mode.
                const stagesRaw = yield* config.get(repoStagesKey(input.repo));
                if (stagesRaw === undefined) return { command, install, timeoutSec };
                const labels = stagesRaw
                  .split(",")
                  .map((l) => l.trim())
                  .filter((l) => l.length > 0);
                // A PRESENT key that yields no labels ("", " , ") is a typo'd
                // config, and silently un-staging the run would reproduce the
                // original defect (one buffered exec) while the operator
                // believes stages are on. Fail loudly, same as a bad label.
                if (labels.length === 0) {
                  return yield* Effect.fail(
                    new StepFailed({
                      step: "resolve-command",
                      cause:
                        `offload-test: \`${repoStagesKey(input.repo)}\` is set but ` +
                        `contains no labels — delete the key to disable staged mode`,
                    }),
                  );
                }

                // A malformed or duplicate label fails LOUDLY (see
                // STAGE_LABEL_RE's doc): a duplicate would mint two steps named
                // `exec-<label>` and two artifacts named `step-<label>.log`,
                // the second silently clobbering the first.
                const bad = labels.find((l) => !STAGE_LABEL_RE.test(l));
                if (bad !== undefined || new Set(labels).size !== labels.length) {
                  return yield* Effect.fail(
                    new StepFailed({
                      step: "resolve-command",
                      cause:
                        `offload-test: invalid \`${repoStagesKey(input.repo)}\` — ` +
                        (bad !== undefined
                          ? `label \`${bad}\` does not match ${String(STAGE_LABEL_RE)}`
                          : `duplicate label`),
                    }),
                  );
                }

                const stages: ResolvedStage[] = [];
                for (const label of labels) {
                  // Falling back to the unlabelled command is legal but
                  // suspicious when stages are declared (usually a typo'd key):
                  // warn here and record it on the exec-step metadata below.
                  const labelled = yield* config.get(stageCommandKey(input.repo, label));
                  const stageCommand =
                    labelled !== undefined && labelled.trim().length > 0 ? labelled : command;
                  const commandFellBack = stageCommand !== labelled;
                  if (commandFellBack) {
                    yield* io.log(
                      "warn",
                      `offload-test: stage \`${label}\` has no \`${stageCommandKey(input.repo, label)}\` — falling back to the unlabelled command`,
                    );
                  }
                  if (stageCommand === undefined || stageCommand.trim().length === 0) {
                    return yield* Effect.fail(
                      new StepFailed({
                        step: "resolve-command",
                        cause:
                          `offload-test: stage \`${label}\` has no command — set ` +
                          `CONFIG_KV \`${stageCommandKey(input.repo, label)}\` or the ` +
                          `unlabelled \`${repoCommandKey(input.repo)}\` fallback`,
                      }),
                    );
                  }
                  stages.push({
                    label,
                    command: stageCommand,
                    timeoutSec: parseIntConfig(
                      yield* config.get(stageTimeoutKey(input.repo, label)),
                    ),
                    commandFellBack,
                  });
                }
                return { command, install, timeoutSec, stages };
              }),
            )
          : {
              command: input.command,
              install: undefined,
              timeoutSec: undefined,
            };
      const stages = resolved.stages;
      const command = resolved.command;
      // Unstaged only: with stages declared, every stage already carries a
      // resolved command (the step above fails otherwise), and the unlabelled
      // command may legitimately be absent.
      if (stages === undefined && (command === undefined || command.trim().length === 0)) {
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

      // self-heal — (gated, OFF unless `self-heal.ci.enabled=true`) auto-dispatch
      // a fix for a DETERMINISTIC CI failure. Unlike the LLM-driven demo verdict
      // (which needs k-of-n confirmation), a non-zero exit IS ground truth — the
      // command is the deterministic oracle, so one failed command escalates
      // directly. One `ci`-class incident → one child `self-heal-pr`, deduped on
      // `{repo, sha}` so re-runs of the same commit collapse to a single heal (a
      // new push re-heals). Per-heal model spend is bounded by the AgentBudget DO.
      // Best-effort throughout — a dispatch fault never changes this run's check
      // outcome. Shared by the single-exec path and staged mode (where the
      // FAILING stage's command is the oracle); a DEAD stage never heals — there
      // is no ExecResult ground truth to hand the healer.
      // specs/08-self-healing.md § 4 (ci class) + § 9 (dedup).
      const maybeDispatchSelfHeal = (
        failedCommand: string,
        execResult: { readonly exitCode: number; readonly stdout: string },
        failLogUri: string,
      ) =>
        Effect.gen(function* () {
          if (execResult.exitCode === 0) return;
          if ((yield* config.get("self-heal.ci.enabled")) !== "true") return;
          const incident = commandFailureToIncident({
            repo: input.repo,
            sha: input.sha,
            command: failedCommand,
            exitCode: execResult.exitCode,
            logTail: execResult.stdout,
            logUri: failLogUri,
          });
          if (incident === null) return;
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
        });

      // --- Staged mode (semantics: header § Staged mode) ----------------------
      if (stages !== undefined) {
        // Summary ledger — every stage lands here as a ✓/✗/⊘ line, and the
        // failure summary carries the whole list so the check names the stage
        // without the operator opening a single log.
        const lines: string[] = [];
        const skippedLines = (from: number): string[] =>
          stages.slice(from).map((s) => `- ⊘ \`${s.label}\` — skipped`);
        let durationTotalMs = 0;
        let logUri = "";

        for (let i = 0; i < stages.length; i++) {
          const stage = stages[i]!;
          // Labelled rung ?? dispatch value ?? unlabelled rung ?? default. The
          // labelled rung outranks the dispatch value deliberately: staged mode
          // only exists when the dispatch omitted `command` (webhook mode), so
          // a `timeoutSec` riding such a dispatch is a coarse whole-run knob,
          // not a per-stage choice — the stage-specific key is more specific.
          const stageTimeoutSec =
            stage.timeoutSec ?? input.timeoutSec ?? resolved.timeoutSec ?? TIMEOUT_SEC_DEFAULT;

          // Inline (non-step) clock read — feeds ONLY the dead-stage marker +
          // summary below, never the run output, so replay re-reads are
          // harmless (header note 2 applies to output-bearing values).
          const stageStartMs = yield* io.now;

          // Same two-timeout derivation + `retries: 0` as the single exec below
          // (see its comment): the exec's own deadline must fire before the
          // step's, and a red stage is not a transient.
          const exit = yield* Effect.exit(
            step(
              `exec-${stage.label}`,
              () =>
                sandbox.exec({
                  cwd: dir,
                  container,
                  command: stage.command,
                  env: { ...secretEnv, ...input.env },
                  timeoutSec: stageTimeoutSec,
                }),
              {
                timeoutSec: stepTimeoutFor(stageTimeoutSec),
                retries: PLATFORM_RETRIES,
                retryOn: RETRY_ON,
                // Surface the suspicious labelled-key-missing fallback (see
                // ResolvedStage.commandFellBack) on the step record, where an
                // operator reading the step table will actually see it.
                ...(stage.commandFellBack
                  ? { metadata: { "offload-test.commandFallback": true } }
                  : {}),
              },
            ),
          );

          if (Exit.isFailure(exit)) {
            // The stage step DIED — ExecTimeout / ExecFailed / platform kill —
            // and its real log is unavailable. Upload a one-line marker under
            // the stage's own log name so the artifact endpoint never 404s
            // (issue #39's "marker artifact on timeout"), then fail the run
            // naming the stage. Marker is BEST-EFFORT: the container may be as
            // dead as the step, and a marker fault must not mask the stage
            // failure. Elapsed comes from `io.now` — diagnostic only, never in
            // the run OUTPUT, so replay determinism is unaffected.
            const errorClass = Option.match(Cause.failureOption(exit.cause), {
              onSome: (f) => {
                const tag = (f as { _tag?: unknown })._tag;
                if (typeof tag !== "string") return "UnknownError";
                if (tag !== "StepFailed") return tag;
                // The typed tag usually survives the Workflow boundary (the
                // CF step runner re-fails with the surviving Cause). When no
                // Cause survives, the runner re-fails as a bare StepFailed
                // (step-runner-cf) and the class is usually still recoverable
                // from the rendered cause text — recover it there so the
                // marker and rundown can say ExecTimeout vs ExecFailed. A
                // pure platform error (WorkflowInternalError) carries no exec
                // vocabulary to recover; it stays StepFailed, honestly.
                const rendered = String((f as { cause?: unknown }).cause ?? "");
                return INNER_EXEC_ERROR_RE.exec(rendered)?.[1] ?? tag;
              },
              onNone: () => "Defect",
            });
            const elapsedMs = (yield* io.now) - stageStartMs;
            const elapsedS = Math.round(elapsedMs / 1000);
            // Label (STAGE_LABEL_RE), tag, and number only — shell-quote-safe
            // by construction.
            const markerLine = `stage=${stage.label} error=${errorClass} elapsedMs=${elapsedMs}`;
            // The marker rides the marker exec's OWN log stream: `sandbox.exec`
            // streams stdout to an R2 log key and returns it as `logPath`, so
            // uploading THAT key in R2-source mode (no `container` — same mode
            // as the green-stage upload above) works on both sandbox backends.
            // Container-mode upload (`artifact.upload({ container })`) throws
            // on the facade backend, where no Sandbox namespace is wired
            // (runtime-cf/artifact-r2.ts) — the marker never landed there.
            yield* step(
              `upload-log-${stage.label}`,
              () =>
                sandbox
                  .exec({
                    container,
                    command: `printf '%s\\n' '${markerLine}'`,
                    timeoutSec: 30,
                  })
                  .pipe(
                    Effect.flatMap((marker) =>
                      artifact.upload({
                        name: `step-${stage.label}.log`,
                        path: marker.logPath,
                        contentType: "text/plain",
                        signedUrlTTL: "30 days",
                      }),
                    ),
                  ),
              // Best-effort against a possibly-dead container: never inherit
              // the platform's default retries/timeout for work whose failure
              // is already tolerated by the catch below.
              { timeoutSec: 60, retries: 0 },
            ).pipe(
              Effect.catchAllCause((cause) =>
                io.log(
                  "warn",
                  `offload-test: marker upload for dead stage \`${stage.label}\` failed (best-effort) — ${Cause.pretty(cause).slice(0, 400)}`,
                ),
              ),
            );
            lines.push(`- ✗ \`${stage.label}\` — died (\`${errorClass}\`) after ~${elapsedS}s`);
            lines.push(...skippedLines(i + 1));
            // The rundown rides `summaryMd` — the run-authored-markdown channel
            // `AcceptanceFailed` already uses for the red-stage path — so the
            // check-run renders the ✓/✗/⊘ lines and log links as real
            // markdown instead of fencing them inside `stepFailedMd`'s code
            // block. `AcceptanceFailed` itself does not fit here: its required
            // `exitCode` means "the command ran to completion", and a dead
            // stage produced no exit code to report. `cause` stays a plain
            // one-liner for the Workflow error record.
            return yield* Effect.fail(
              new StepFailed({
                step: `exec-${stage.label}`,
                cause: `stage \`${stage.label}\` (\`${stage.command}\`) died: ${errorClass} after ~${elapsedS}s`,
                summaryMd: [
                  `Stage \`${stage.label}\` — \`${stage.command}\` — died (\`${errorClass}\`) after ~${elapsedS}s. ` +
                    `Earlier stage logs are already uploaded; this stage's log is the marker artifact \`step-${stage.label}.log\`.`,
                  "",
                  ...lines,
                ].join("\n"),
              }),
            );
          }

          const result = exit.value;
          durationTotalMs += result.durationMs;
          // upload NOW, before the next stage runs — the whole point of staging.
          logUri = yield* step(`upload-log-${stage.label}`, () =>
            artifact.upload({
              name: `step-${stage.label}.log`,
              path: result.logPath,
              signedUrlTTL: "30 days",
            }),
          );

          if (result.exitCode !== 0) {
            lines.push(
              `- ✗ \`${stage.label}\` — exit \`${result.exitCode}\` in ${(result.durationMs / 1000).toFixed(1)}s ([log ↗](${logUri}))`,
            );
            lines.push(...skippedLines(i + 1));
            yield* maybeDispatchSelfHeal(stage.command, result, logUri);
            if (input.failOnNonZeroExit) {
              return yield* Effect.fail(
                new AcceptanceFailed({
                  exitCode: result.exitCode,
                  summaryMd: [
                    `Stage \`${stage.label}\` — \`${stage.command}\` — exited \`${result.exitCode}\`; later stages skipped.`,
                    "",
                    ...lines,
                  ].join("\n"),
                }),
              );
            }
            // failOnNonZeroExit off: `set -e` semantics — the failing stage's
            // exit code becomes the run's, later stages don't run (they are
            // dependents of the one that just went red).
            return { exitCode: result.exitCode, durationMs: durationTotalMs, logUri };
          }
          lines.push(
            `- ✓ \`${stage.label}\` — ${(result.durationMs / 1000).toFixed(1)}s ([log ↗](${logUri}))`,
          );
        }

        // All stages green. Output mirrors the single-exec contract: exit 0,
        // the SUM of the checkpointed stage durations (replay-safe — each is a
        // memoized step result, header note 2), the LAST stage's log URL.
        return { exitCode: 0, durationMs: durationTotalMs, logUri };
      }

      // --- Single-exec path (unchanged 1.1.0 behaviour) ----------------------
      // TS cannot carry the pre-checkout no-command guard's narrowing across
      // the staged branch above — re-derive; the fail arm is unreachable.
      const soleCommand =
        command ??
        (yield* Effect.fail(
          new StepFailed({
            step: "resolve-command",
            cause: "unreachable: command presence checked before checkout",
          }),
        ));

      // exec — run the command. A non-zero exit code is a NORMAL ExecResult
      // (a failing test), surfaced to the output below — never an Effect
      // failure. `sandbox.exec` fails its Effect only with ExecFailed /
      // ExecTimeout, which propagate out of the run unchanged. `result` is the
      // checkpointed step output — replay restores it identically, which is
      // why the run's `durationMs` is read from it (see header note 2).
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
      // bug in it — with `STEP_TIMEOUT_HEADROOM_SEC` on top so the exec's
      // deadline is the one that fires (see the constant's doc).
      //
      const result = yield* step(
        "exec",
        () =>
          sandbox.exec({
            cwd: dir,
            container,
            command: soleCommand,
            // Per-dispatch `env` wins over a same-named config-store secret —
            // the more specific source overrides the global one.
            env: { ...secretEnv, ...input.env },
            timeoutSec,
          }),
        { timeoutSec: stepTimeoutFor(timeoutSec), retries: PLATFORM_RETRIES, retryOn: RETRY_ON },
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

      // self-heal — see `maybeDispatchSelfHeal` above (shared with staged mode).
      yield* maybeDispatchSelfHeal(soleCommand, result, logUri);

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
              `Command \`${soleCommand}\` exited \`${result.exitCode}\`.`,
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
