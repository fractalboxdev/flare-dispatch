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
} from "@fractalbox/flare-dispatch-core";
import { workspace } from "@fractalbox/flare-dispatch-core/primitives";

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

/** Output contract — identical shape to `offload-test`. */
const OxlintOutput = Schema.Struct({
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  logUri: Schema.String, // signed R2 URL to the oxlint log
});

/** Default `exec` timeout — lint is fast, so a tighter ceiling than tests. */
const DEFAULT_TIMEOUT_SEC = 300;

export const oxlint = defineRun({
  name: "oxlint",
  version: "1.0.0",

  // Webhook-mode trigger — the zero-GHA lint gate. Fires on every PR push; the
  // run resolves oxlint from `npx`, so the sync, payload-only callback carries
  // no command. `failOnNonZeroExit: true` because the check-run is the only
  // pass/fail signal. Gate mirrors `offload-test`: skip drafts + dependabot.
  triggers: [
    {
      event: "pull_request",
      actions: ["opened", "synchronize", "reopened", "ready_for_review"],
      idempotencyKey: ({ payload }) =>
        `oxlint:${String(
          payload.repository?.full_name ?? "unknown/unknown",
        ).replace(/\//g, "_")}:${String(
          payload.pull_request?.head?.sha ?? "",
        ).slice(0, 12)}`,
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
      const result = yield* step("exec", () =>
        sandbox.exec({
          cwd: dir,
          container,
          command,
          timeoutSec: DEFAULT_TIMEOUT_SEC,
        }),
      );

      // upload-log — push the oxlint output to R2, get a signed URL.
      const logUri = yield* step("upload-log", () =>
        artifact.upload({
          name: "oxlint.log",
          path: result.logPath,
          signedUrlTTL: "30 days",
        }),
      );

      // fail-on-nonzero — a lint finding (non-zero exit) turns the check red,
      // carrying the log link, the same way `offload-test` renders a failure.
      //
      // The one infra failure that used to masquerade as a finding here — the
      // checkout dir reaped between steps, so `npx` could not even `cd` into it —
      // no longer reaches this point: `sandbox.exec` reclassifies it as a
      // retryable `ExecFailed` (see sandbox-cf.ts `isWorkingDirFailure`),
      // surfaced as a generic "execution failed", not a lint verdict. OTHER ways
      // `npx oxlint` can exit non-zero without a genuine finding (an unfetchable
      // version, a malformed `.oxlintrc.json`) still land here, so the wording
      // points at the log rather than asserting violations outright.
      if (input.failOnNonZeroExit && result.exitCode !== 0) {
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
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        logUri,
      };
    }),
});
