// `worker-deploy` — continuous deployment on default-branch push.
//
// The CD counterpart of `offload-test`: clone the pushed SHA, run the repo's
// deploy command (typically `pnpm build && wrangler deploy`) in a Sandbox
// container with credentials injected from the config store, upload the log,
// and post a green/red `flare-dispatch/worker-deploy` check on the deployed
// SHA. Pairs with `deploy-smoke` (post-deploy probe) the way CI pairs with CD.
//
// --- Pure webhook mode: `check_suite` as the push signal ----------------------
//
// The FlareDispatch App does not subscribe to `push` — and does not need to.
// GitHub creates a check suite for the head commit of every push and delivers
// `check_suite.requested` to apps with `checks: write`, so the App's existing
// subscription set already carries a per-push signal with `head_branch` +
// `head_sha` on it. The trigger gates on `head_branch === repository.
// default_branch`: feature-branch pushes (whose PRs `offload-test` /
// `pr-review` already cover) never reach this run.
//
// --- Unconfigured repos no-op green -------------------------------------------
//
// A webhook trigger fires for EVERY installed repo's default-branch push, and
// its `gate` is sync + payload-only — it cannot ask the config store whether
// the repo opted in. So opt-in is resolved in the run body: no
// `worker-deploy.command:<owner/repo>` in CONFIG_KV → the run returns
// `{ deployed: false, skippedReason: "not-configured" }` and the check stays
// green. There is deliberately NO dispatcher-wide command fallback (unlike
// `offload-test`): a deploy command is inherently per-repo, and a global
// default would deploy-storm every installed repo.
//
// --- Credentials --------------------------------------------------------------
//
// DEPRECATED, and this run is the case that retires it. ADR-0006 bars a
// long-lived credential from inside a container, and `CLOUDFLARE_API_TOKEN` in
// the deploy command's env is exactly that — readable by anything the repo's
// build runs, kept out of the log by `redactValues` but not out of the process.
// `wrangler deploy` authenticates its own HTTPS calls to `api.cloudflare.com`,
// so there is no artifact to write back: it ships on the `cf-api` grant profile
// instead, where the substrate's egress handler attaches the token to the
// outbound request and the container holds nothing. The env path below stays
// until the dispatcher consumes the facade, and goes at stage-2 exit.
// See apps/substrate/specs/credential-boundary.md.
//
// Until then, the contract is `offload-test` header note 3: secret *names* ride the
// config store, never the dispatch body. Webhook dispatches can't name
// secrets either (sync, payload-only `inputs`), so the run body resolves the
// env-var names from `worker-deploy.secrets:<owner/repo>` (comma-separated)
// and the optional config-store prefix from
// `worker-deploy.secret-prefix:<owner/repo>`, then loads the values with
// `loadSecrets({ required: true })` — INLINE, not in a `step(...)`, so
// plaintext credentials never land in a checkpointed step result. The
// resolve-config step checkpoints only the key *names*.
//
// Prefer Worker env for credential *values* (never put API tokens in KV):
//   wrangler secret put CLOUDFLARE_API_TOKEN
//   CLOUDFLARE_ACCOUNT_ID  — already a wrangler `vars` on the dispatcher
// `loadSecrets` resolves via the `secrets` capability (Worker string
// bindings only — no CONFIG_KV). Commands + secret *names* stay in KV.
//
// --- A deploy is never step-retried -------------------------------------------
//
// The `exec` step carries explicit StepOpts: `retries: 0`, and a step timeout
// of the exec timeout plus headroom. Left bare, the step inherits Cloudflare
// Workflows' defaults — a 10-minute step timeout and several retries — so a
// deploy command that outruns 600s is killed at the step boundary and run
// AGAIN in the same container (its log lands as `exec-2.ndjson`), publishing
// every Worker a second time. A deploy is not idempotent the way a test is:
// each attempt ships a new version. So no failure class is retried here, not
// even a platform `StepFailed` — a killed step may already have published.
//
// --- Several deploys of one commit: `checkLabel` ------------------------------
//
// A repo can deploy one SHA more than once with different work — the webhook
// deploys its Workers, and an Action-mode dispatch deploys container-backed
// Workers after a GHA image build. Both would post `flare-dispatch/worker-deploy`
// and overwrite each other's verdict. A `checkLabel` names the second one
// `flare-dispatch/worker-deploy:<label>` (apps/dispatcher/src/check-name.ts),
// and folds into both the Action's `Idempotency-Key` and the direct-dispatch
// instance id, so it stays its own execution.
//
// A labelled dispatch that omits `command` reads ONLY
// `worker-deploy.command:<repo>:<label>` — never the unlabelled key. Unlike
// `check`'s ladder, falling back would re-run the webhook's deploy under a
// second name.
//
// --- Deploy ordering ----------------------------------------------------------
//
// Two rapid pushes dispatch two executions keyed by SHA; completion order is
// not guaranteed, so the older push can in principle deploy last. A repo where
// that matters guards inside its command. The checkout's `origin` is the
// UNAUTHENTICATED `https://github.com/<owner>/<name>.git` — the sandbox scrubs
// the clone credential (packages/runtime-cf/src/sandbox-cf.ts,
// `scrubCloneCredential`) — so `git ls-remote origin` answers only for a repo
// readable anonymously. On a private repo it fails, and a guard of the shape
// `[ "$(git ls-remote …)" = "$(git rev-parse HEAD)" ] || exit 0` then skips
// EVERY deploy green. A guard must fail closed when the lookup fails:
//   tip=$(git ls-remote origin refs/heads/main) && [ -n "$tip" ] || exit 1
//   [ "${tip%%[[:space:]]*}" = "$(git rev-parse HEAD)" ] || exit 0
//
// Spec: specs/02-runs.md § worker-deploy, specs/04-gha-integration.md
// § Webhook mode.

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

const WorkerDeployInput = Schema.Struct({
  repo: Schema.String, // "owner/name"
  sha: Schema.String, // the pushed head SHA — what gets checked out + deployed
  /** Branch the push landed on — context for logs/summaries only. */
  branch: Schema.optional(Schema.String),
  /**
   * The deploy command, e.g. `pnpm install --frozen-lockfile && pnpm build &&
   * pnpm exec wrangler deploy`. OPTIONAL: a webhook-mode dispatch omits it and
   * the run body resolves `worker-deploy.command:<owner/repo>` from CONFIG_KV.
   * No per-repo key → the run no-ops green (see header).
   */
  command: Schema.optional(Schema.String),
  /**
   * Names a second deploy of the same commit: the check-run posts as
   * `flare-dispatch/worker-deploy:<label>` and a command-less dispatch reads
   * `worker-deploy.command:<repo>:<label>` (see header). Same pattern as
   * `check`'s label, so a malformed one is a 400 at dispatch.
   */
  checkLabel: Schema.optional(
    Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/)),
  ),
  image: Schema.optional(Schema.String), // container image override
  /** Run the R2-cached dependency install after the clone. */
  install: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  /** Non-sensitive env only — dispatch inputs are persisted. */
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  /**
   * Env-var names resolved from the config store into the command's env.
   * Empty on webhook dispatches — the run body falls back to
   * `worker-deploy.secrets:<owner/repo>` (comma-separated names).
   *
   * @deprecated ADR-0006 — this run is the credential boundary's acceptance
   * case. `wrangler deploy` reaches `api.cloudflare.com`, so it ships on the
   * `cf-api` grant profile: the substrate's egress handler attaches
   * `CLOUDFLARE_API_TOKEN` to the request, and the container holds nothing
   * (apps/substrate/specs/credential-boundary.md). Removed at stage-2 exit.
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
  /** `sandbox.exec` timeout. Omitted → `worker-deploy.timeoutSec:<repo>` → 900. */
  timeoutSec: Schema.optional(Schema.Number),
  /**
   * Fail the run Effect (→ red check) on a non-zero exit. Webhook mode sets
   * this true — the check-run is the only signal a deploy failed. Action mode
   * defaults false and reads `exitCode`, mirroring `offload-test`.
   */
  failOnNonZeroExit: Schema.optionalWith(Schema.Boolean, {
    default: () => false,
  }),
});

const WorkerDeployOutput = Schema.Struct({
  /** True when the deploy command ran and exited 0. */
  deployed: Schema.Boolean,
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  /** Signed R2 URL to the deploy log. Absent when the run no-oped. */
  logUri: Schema.optional(Schema.String),
  /** Why the run no-oped (e.g. "not-configured"). Absent when it deployed. */
  skippedReason: Schema.optional(Schema.String),
});

/** Default `exec` timeout — a build + `wrangler deploy` fits comfortably. */
const TIMEOUT_SEC_DEFAULT = 900;

/**
 * Headroom added to the exec timeout to derive the Workflow STEP timeout, so
 * the sandbox's own deadline fires first (a clean `ExecTimeout` with the log
 * so far) instead of the platform killing the step. Same constant as
 * `offload-test` / `check`.
 */
const STEP_TIMEOUT_HEADROOM_SEC = 120;

/** Decoded input — pins the trigger's `inputs` return to the full shape. */
type WorkerDeployI = Schema.Schema.Type<typeof WorkerDeployInput>;

/**
 * CONFIG_KV keys — all strictly per-repo (see header: no global fallback). A
 * labelled dispatch's command key is its own, with no unlabelled fallback.
 */
const commandKey = (repo: string, checkLabel?: string): string =>
  checkLabel === undefined
    ? `worker-deploy.command:${repo}`
    : `worker-deploy.command:${repo}:${checkLabel}`;
const secretsKey = (repo: string): string => `worker-deploy.secrets:${repo}`;
const secretPrefixKey = (repo: string): string => `worker-deploy.secret-prefix:${repo}`;

/**
 * Per-repo exec timeout, for webhook dispatches — the trigger's `inputs` is
 * sync + payload-only and cannot carry one, so without this key webhook mode
 * is pinned to 900s:
 *
 *   wrangler kv key put --binding=CONFIG_KV "worker-deploy.timeoutSec:owner/repo" "1500"
 *
 * A labelled dispatch reads `…:<repo>:<label>` first and falls back to the
 * repo key — a timeout, unlike a command, is safe to share. A dispatch that
 * passes `timeoutSec` wins over both.
 */
const timeoutKeys = (repo: string, checkLabel: string | undefined): readonly string[] =>
  checkLabel === undefined
    ? [`worker-deploy.timeoutSec:${repo}`]
    : [`worker-deploy.timeoutSec:${repo}:${checkLabel}`, `worker-deploy.timeoutSec:${repo}`];

/** A positive integer, or `undefined` for absent/garbage — never `NaN`. */
const parseIntConfig = (raw: string | undefined): number | undefined => {
  const n = Number(raw?.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

export const workerDeploy = defineRun({
  name: "worker-deploy",
  // 1.1.0 — additive: `checkLabel`, `worker-deploy.timeoutSec:<repo>`, and
  // explicit exec StepOpts (no step retries, step timeout ≥ exec timeout).
  version: "1.1.0",

  // Webhook-mode trigger — `check_suite.requested` is GitHub's per-push signal
  // to checks-writing Apps (see header). Gated to the repo's default branch.
  triggers: [
    {
      event: "check_suite",
      actions: ["requested"],
      // Instance id `worker-deploy_{repo_}_{sha12}` — dedups webhook
      // redeliveries of one push. It does NOT collapse with an Action-mode
      // dispatch: the Action sends `Idempotency-Key: worker-deploy-{repo_}-{sha12}`
      // (hyphens, actions/flare-dispatch-action/dispatch.sh), a distinct id, so
      // both deploys run. Only a direct dispatch WITHOUT that header lands on
      // this id (routes/dispatch.ts `semanticInstanceId`).
      idempotencyKey: ({ payload }) =>
        `worker-deploy:${String(payload.repository?.full_name ?? "unknown/unknown").replace(
          /\//g,
          "_",
        )}:${String(payload.check_suite?.head_sha ?? "").slice(0, 12)}`,
      gate: ({ payload }) =>
        typeof payload.check_suite?.head_branch === "string" &&
        payload.check_suite.head_branch === payload.repository?.default_branch,
      inputs: ({ payload }): WorkerDeployI => ({
        repo: String(payload.repository?.full_name ?? "unknown/unknown"),
        sha: String(payload.check_suite?.head_sha ?? ""),
        branch: String(payload.check_suite?.head_branch ?? ""),
        // The check-run is the only failure signal in webhook mode.
        failOnNonZeroExit: true,
        // Decoded-shape defaults the trigger return must restate.
        install: false,
        secrets: [],
      }),
    },
  ],

  inputs: WorkerDeployInput,
  outputs: WorkerDeployOutput,

  limits: {
    maxDurationSec: 1800,
  },

  run: (input) =>
    Effect.gen(function* () {
      // resolve-config — the per-repo deploy command, exec timeout, and secret
      // key NAMES (never values: this step's return is checkpointed). Missing
      // command → the repo hasn't opted in; no-op green rather than failing
      // every push of every installed repo.
      const cmdKey = commandKey(input.repo, input.checkLabel);
      const cfg = yield* step("resolve-config", () =>
        Effect.gen(function* () {
          const command = input.command ?? (yield* config.get(cmdKey));
          const timeoutSec =
            input.timeoutSec ??
            (yield* Effect.reduce(
              timeoutKeys(input.repo, input.checkLabel),
              undefined as number | undefined,
              (found, key) =>
                found !== undefined
                  ? Effect.succeed(found)
                  : config.get(key).pipe(Effect.map(parseIntConfig)),
            ));
          const secretNames =
            input.secrets.length > 0
              ? [...input.secrets]
              : ((yield* config.get(secretsKey(input.repo))) ?? "")
                  .split(",")
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0);
          const secretPrefix =
            input.secretPrefix ?? (yield* config.get(secretPrefixKey(input.repo)));
          return { command, timeoutSec, secretNames, secretPrefix };
        }),
      );
      if (cfg.command === undefined || cfg.command.trim().length === 0) {
        yield* io.log(
          "warn",
          `worker-deploy: no \`${cmdKey}\` in the config store — repo not opted in, skipping`,
        );
        return {
          deployed: false,
          exitCode: 0,
          durationMs: 0,
          skippedReason: "not-configured",
        };
      }
      const command = cfg.command;

      // checkout — container + clone at the pushed SHA (+ optional cached
      // install), same opening move as offload-test.
      const { container, dir } = yield* step("checkout", () =>
        workspace({
          repo: input.repo,
          sha: input.sha,
          image: input.image,
          install: input.install,
        }),
      );

      // load-secrets — INLINE (never in a step): plaintext credentials must
      // not land in checkpointed Workflow state. `required: true` — a deploy
      // missing its credentials must fail fast + legibly, not half-run.
      const secretEnv = yield* loadSecrets(cfg.secretNames, {
        prefix: cfg.secretPrefix,
        required: true,
      });

      // exec — the deploy itself. A non-zero exit is a normal ExecResult here;
      // the failOnNonZeroExit branch below decides whether it reds the check.
      // StepOpts are explicit (see header § A deploy is never step-retried):
      // `retries: 0`, and a step timeout above the exec's so the sandbox
      // deadline, not the platform's 600s default, ends a long deploy.
      const execTimeoutSec = cfg.timeoutSec ?? TIMEOUT_SEC_DEFAULT;
      const result = yield* step(
        "exec",
        () =>
          sandbox.exec({
            cwd: dir,
            container,
            command,
            // Per-dispatch `env` wins over a same-named config-store secret.
            env: { ...secretEnv, ...input.env },
            // Scrub secret VALUES from the captured log before it is persisted,
            // in case the command echoes its env. Not hypothetical here: a deploy
            // command is the one that carries a cloud provider's write-scoped API
            // token, and `wrangler`-class tools print their environment on some
            // error paths. The log lands in R2 on a stable path (artifact TTLs are
            // not yet enforced), so a leak there is durable.
            redactValues: Object.values(secretEnv),
            timeoutSec: execTimeoutSec,
          }),
        { timeoutSec: execTimeoutSec + STEP_TIMEOUT_HEADROOM_SEC, retries: 0 },
      );

      // upload-log — the deploy log as a signed R2 artifact.
      const logUri = yield* step("upload-log", () =>
        artifact.upload({
          name: "step.log",
          path: result.logPath,
          signedUrlTTL: "30 days",
        }),
      );

      if (input.failOnNonZeroExit && result.exitCode !== 0) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: result.exitCode,
            summaryMd: [
              `Deploy command \`${command}\` exited \`${result.exitCode}\` — the push to ${
                input.branch ?? "the default branch"
              } is NOT deployed.`,
              "",
              `[View full deploy log ↗](${logUri})`,
            ].join("\n"),
          }),
        );
      }

      return {
        deployed: result.exitCode === 0,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        logUri,
      };
    }),
});
