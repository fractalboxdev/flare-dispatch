// `oxlint` — the install-free lint gate.
//
// Clones a repo and runs oxlint (the Rust linter from the Oxc toolchain, part
// of the Vite/VoidZero stack now inside Cloudflare) in a Sandbox container,
// uploads the log to R2, and posts a green/red `flare-dispatch/oxlint` check.
//
// This is the CHEAPEST run in the catalog: oxlint needs NO `pnpm install` — it
// lints source directly, with no type information and no dependency resolution
// — so the body is just `checkout → exec → upload-log` with `install: false`
// and a sub-second Rust binary. That makes it the ideal fast pre-flight gate to
// require in branch protection BEFORE the expensive test / e2e / pr-review runs
// burn container minutes: a lint break fails in ~seconds, not after a full
// install + test cycle.
//
// Contract mirrors `offload-test` (specs/02-runs.md § 1, specs/03-dsl.md
// § Top-level shape) — the only differences are the baked-in command (oxlint,
// resolved from the catalog via `npx`, no per-repo CONFIG_KV lookup) and that
// `failOnNonZeroExit` defaults ON: a lint finding has no other pass/fail
// signal, so a non-zero exit must turn the check red in every mode.
//
// Because it installs nothing and configures nothing, the gate is droppable on
// ANY repo — including one that never adopted oxlint (no `.oxlintrc.json`, no
// oxlint dependency), where it lints with oxlint's own defaults. The corollary
// is that it also lands on repos with NOTHING to lint (no JS/TS at all, or an
// all-gitignored tree), where oxlint exits 1 on an empty file set — a no-op the
// body reclassifies as a green `skipped`, never a red check. See `skipped` in
// the output contract and `isNothingToLint`.
//
// Determinism: like `offload-test`, the body reads `durationMs` from the
// checkpointed `exec` step result and calls no `Date.now()` / `crypto.randomUUID()`
// (specs/pm/plan.md § 6 "Run replay determinism").

import { Effect, Schema } from "effect";
import {
  AcceptanceFailed,
  artifact,
  defineRun,
  sandbox,
  step,
} from "@fractalboxdev/flare-dispatch-core";
import {
  ensureWorkspace,
  isNothingToLint,
  workspace,
} from "@fractalboxdev/flare-dispatch-core/primitives";

/** Input contract — repo/sha plus oxlint knobs. */
const OxlintInput = Schema.Struct({
  repo: Schema.String, // "owner/name"
  sha: Schema.String,
  /**
   * Extra oxlint CLI args appended verbatim, e.g. `"--deny-warnings"` or a path
   * filter `"src"`. Empty by default — oxlint auto-discovers `.oxlintrc.json`
   * and lints the working tree.
   */
  args: Schema.optionalWith(Schema.String, { default: () => "" }),
  /**
   * npm dist-tag / version of oxlint to fetch via `npx`. Defaults to the major
   * line `"1"` so a consumer tracks oxlint 1.x without redeploying this run.
   */
  version: Schema.optionalWith(Schema.String, { default: () => "1" }),
  /**
   * Fail the run Effect (→ red `flare-dispatch/oxlint` check) on a non-zero
   * exit. Defaults ON — unlike `offload-test`, a lint run has no GHA step that
   * reads `exitCode`, so the check-run is the only signal and a finding must
   * turn it red. Set false to surface findings as a green check carrying the
   * count (advisory mode).
   */
  failOnNonZeroExit: Schema.optionalWith(Schema.Boolean, {
    default: () => true,
  }),
});

/** Output contract — `offload-test`'s shape plus the no-op signal. */
const OxlintOutput = Schema.Struct({
  /**
   * oxlint's exit — but NORMALIZED to 0 when there was nothing to lint (see
   * `skipped`). An Action-mode caller gates on this field the way it gates on
   * `offload-test`'s, so the one non-zero exit that is not a verdict must not
   * reach it.
   */
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  logUri: Schema.String, // signed R2 URL to the oxlint log
  /**
   * True when oxlint found NOTHING to lint — a repo with no JS/TS surface, an
   * all-gitignored tree, or an `args` filter matching no file. A clean pass over
   * zero files, not a clean pass over the repo: the distinction `exitCode: 0`
   * alone cannot carry, kept out of band so nothing reads a green check as
   * "oxlint vouched for this code".
   */
  skipped: Schema.Boolean,
});

/** Default `exec` timeout — lint is fast, so a tighter ceiling than tests. */
const TIMEOUT_SEC_DEFAULT = 300;

/** Platform-failure retries — see the `exec` step. A verdict is never retried. */
const PLATFORM_RETRIES = 3;
const RETRY_ON = ["ExecFailed"] as const;

export const oxlint = defineRun({
  name: "oxlint",
  version: "1.1.0",

  // Webhook-mode trigger — the zero-GHA lint gate. Fires on every PR push; the
  // run resolves oxlint from `npx`, so the sync, payload-only callback carries
  // no command. `failOnNonZeroExit: true` because the check-run is the only
  // pass/fail signal. Gate mirrors `offload-test`: skip drafts + dependabot.
  triggers: [
    {
      event: "pull_request",
      actions: ["opened", "synchronize", "reopened", "ready_for_review"],
      idempotencyKey: ({ payload }) =>
        `oxlint:${String(payload.repository?.full_name ?? "unknown/unknown").replace(
          /\//g,
          "_",
        )}:${String(payload.pull_request?.head?.sha ?? "").slice(0, 12)}`,
      gate: ({ payload }) =>
        payload.pull_request?.draft !== true &&
        payload.pull_request?.user?.login !== "dependabot[bot]",
      inputs: ({ payload }) => ({
        repo: String(payload.repository?.full_name ?? "unknown/unknown"),
        sha: String(payload.pull_request?.head?.sha ?? ""),
        // The decoded input type carries these (their schema defaults); the
        // trigger restates them since `inputs` returns the decoded shape.
        args: "",
        version: "1",
        failOnNonZeroExit: true,
      }),
    },
  ],

  inputs: OxlintInput,
  outputs: OxlintOutput,

  limits: {
    // Wall-time ceiling — lint is cheap, but a cold `npx` fetch + a huge tree
    // gets headroom.
    maxDurationSec: 600,
  },

  run: (input) =>
    Effect.gen(function* () {
      // checkout — acquire a container (default lean image; oxlint needs only
      // Node for `npx`), clone at the SHA. NO install: oxlint lints source
      // directly, so `node_modules` is never needed (the whole point — a
      // near-free gate).
      const { container, dir } = yield* step("checkout", () =>
        workspace({
          repo: input.repo,
          sha: input.sha,
          install: false,
        }),
      );

      // exec — fetch + run oxlint via `npx`. The args are appended verbatim;
      // the `.trim()` collapses the trailing space when `args` is empty.
      const command = `npx --yes oxlint@${input.version} ${input.args}`.trim();
      // Retries cover the PLATFORM, never the verdict. oxlint exiting non-zero
      // is a normal `ExecResult` decided below; only `ExecFailed` fails the
      // Effect, and that is the container rather than the code (observed
      // elsewhere as `exec failed (exit -1): HTTP error! status: 500`).
      const result = yield* step(
        "exec",
        () =>
          // Re-established INSIDE the retryable step: a container recycled
          // between steps takes the checkout with it, and the retry would
          // otherwise re-run `npx` in a directory that is gone — three times,
          // reporting the missing directory as the repo's lint verdict.
          ensureWorkspace({
            current: { container, dir },
            repo: input.repo,
            sha: input.sha,
            install: false,
          }).pipe(
            Effect.flatMap((ws) =>
              sandbox.exec({
                cwd: ws.dir,
                container: ws.container,
                command,
                timeoutSec: TIMEOUT_SEC_DEFAULT,
              }),
            ),
          ),
        { retries: PLATFORM_RETRIES, retryOn: RETRY_ON },
      );

      // upload-log — push the oxlint output to R2, get a signed URL.
      const logUri = yield* step("upload-log", () =>
        artifact.upload({
          name: "oxlint.log",
          path: result.logPath,
          signedUrlTTL: "30 days",
        }),
      );

      // nothing-to-lint — oxlint exits 1, with no finding, when the tree holds
      // no file it can lint: a repo with no JS/TS at all (Rust/Python/Go/docs),
      // a tree whose sources are entirely gitignored, or an `args` path filter
      // matching nothing. This run is the INSTALL-FREE gate — it is meant to be
      // dropped on any repo, including ones that never adopted oxlint — so that
      // exit is a no-op, not a verdict, and must not turn the check red.
      // Classified on the output sentinel, never the exit code, which cannot
      // tell the two apart (see `isNothingToLint`).
      const skipped = isNothingToLint(`${result.stdout}\n${result.stderr}`);

      // fail-on-nonzero — a lint finding (non-zero exit) turns the check red,
      // carrying the log link, the same way `offload-test` renders a failure.
      //
      // Two non-zero exits that are NOT findings are already excluded by the
      // time we get here: the checkout dir reaped between steps, so `npx` could
      // not even `cd` into it (`sandbox.exec` reclassifies it as a retryable
      // `ExecFailed` — see sandbox-cf.ts `isWorkingDirFailure`), and the
      // nothing-to-lint no-op above. OTHER ways `npx oxlint` can exit non-zero
      // without a genuine finding (an unfetchable version, a malformed
      // `.oxlintrc.json`) still land here, so the wording points at the log
      // rather than asserting violations outright.
      if (input.failOnNonZeroExit && result.exitCode !== 0 && !skipped) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: result.exitCode,
            summaryMd: [
              `\`${command}\` exited \`${result.exitCode}\` — oxlint reported lint problems (or failed to run; see the log).`,
              "",
              `[View full oxlint log ↗](${logUri})`,
            ].join("\n"),
          }),
        );
      }

      return {
        // A no-op is a pass: report 0 so an Action-mode caller gating on
        // `exitCode` stays green, and carry the truth in `skipped`.
        exitCode: skipped ? 0 : result.exitCode,
        durationMs: result.durationMs,
        logUri,
        skipped,
      };
    }),
});
