// @fractalboxdev/flare-dispatch-runtime-cf — ChecksGithubLive: the live `checks` capability.
//
// Backs the `Checks` Context.Tag with the GitHub App check-runs API, via
// `@fractalboxdev/flare-dispatch-github-app`: an RS256 App JWT is exchanged for a short-lived
// installation token (cached in Worker memory), and that token authenticates
// `POST` / `PATCH /repos/{owner}/{repo}/check-runs`. This is the GitHub half of
// the `finalize` boundary — the D1 half is `D1ExecutionsLive`.
//
// --- Out-of-band context (the `makeD1ExecutionsLive` pattern) ----------------
//
// The core `ChecksService` interface is run-agnostic — `create`/`update` carry
// only `repo` / `sha` / `name`, not the App credentials. The App id, PEM, and
// installation id are runtime-specific and per-execution, so — exactly like
// `makeD1ExecutionsLive`'s `ExecutionContext` — they are injected into the
// Layer constructor (`ChecksGithubConfig`) and closed over. `RunWorkflow`
// derives them from `env` + the dispatch payload.
//
// --- Graceful degradation ----------------------------------------------------
//
// In local dev (no `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` secret) or when a
// dispatch carries no `installation_id`, there are no credentials to mint a
// token with. A check-run is *reporting*, not *correctness* — a missing PR
// check must never fail an otherwise-green execution. So when credentials are
// absent, `makeChecksGithubLive` returns a **no-op** service: `create` resolves
// to a sentinel id and `update` is a no-op, both logging at info level. The
// execution still runs, records its D1 rows, and uploads its log — only the
// GitHub check-run is skipped. PR5 supplies `installation_id`; with real
// secrets configured the live path is taken.
//
// A network/API failure *with* credentials present is different: it is a
// genuine defect (`Effect.orDie`) — a misconfigured App or a GitHub outage
// should surface loudly, not be silently swallowed.
//
// Spec: specs/04-gha-integration.md § Check-runs callback, specs/05-byoc.md
// § Secrets / § Security posture, specs/pm/plan.md § PR6 / § 6.

import {
  createCheckRun,
  getInstallationToken,
  progressCheckRun,
  updateCheckRun,
} from "@fractalboxdev/flare-dispatch-github-app";
import { Effect, Layer } from "effect";
import { Checks, type ChecksService } from "@fractalboxdev/flare-dispatch-core";

/**
 * The GitHub App credentials + installation context the live `Checks` Layer
 * needs but the run-agnostic `ChecksService` interface does not carry.
 * Supplied by `RunWorkflow` from `env` + the dispatch payload.
 */
export type ChecksGithubConfig = {
  /** `GITHUB_APP_ID` — the numeric App id. */
  readonly appId: string;
  /** `GITHUB_APP_PRIVATE_KEY` — the App's PKCS#8 PEM private key. */
  readonly privateKeyPem: string;
  /** The installation id from the dispatch payload's `github.installation_id`. */
  readonly installationId: number;
};

/** Sentinel id `create` returns when running degraded (no credentials). */
export const NOOP_CHECK_RUN_ID = "noop";

/**
 * A `ChecksService` that does nothing but log — the graceful-degradation path
 * when App credentials or the installation id are absent (local dev). The
 * execution proceeds; only the GitHub check-run is skipped.
 */
const makeNoopChecks = (reason: string): ChecksService => ({
  create: ({ name }) =>
    Effect.as(
      Effect.logInfo(
        `checks.create skipped (${reason}) — check-run "${name}" not posted`,
      ),
      NOOP_CHECK_RUN_ID,
    ),
  progress: () =>
    Effect.logInfo(
      `checks.progress skipped (${reason}) — in-progress output not posted`,
    ),
  update: ({ conclusion }) =>
    Effect.logInfo(
      `checks.update skipped (${reason}) — conclusion "${conclusion}" not posted`,
    ),
});

/**
 * Build the `Checks` Layer. When `config` is `undefined` (no App secrets) the
 * Layer is the no-op service above; otherwise it is the live GitHub-App-backed
 * service.
 */
export const makeChecksGithubLive = (
  config: ChecksGithubConfig | undefined,
): Layer.Layer<Checks> => {
  if (config === undefined) {
    return Layer.succeed(
      Checks,
      makeNoopChecks("GitHub App credentials not configured"),
    );
  }

  // Resolve a fresh-or-cached installation token. A failure here (bad PEM,
  // GitHub down) is a defect — credentials are present, so this *should* work.
  const token = (): Effect.Effect<string> =>
    Effect.tryPromise({
      try: () =>
        getInstallationToken({
          appId: config.appId,
          privateKeyPem: config.privateKeyPem,
          installationId: config.installationId,
        }),
      catch: (cause) =>
        new Error("ChecksGithubLive: installation-token exchange failed", {
          cause,
        }),
    }).pipe(Effect.orDie);

  const service: ChecksService = {
    create: ({ repo, sha, name, output, detailsUrl }) =>
      Effect.gen(function* () {
        const accessToken = yield* token();
        return yield* Effect.tryPromise({
          try: () =>
            createCheckRun({
              token: accessToken,
              repo,
              sha,
              name,
              output,
              detailsUrl,
            }),
          catch: (cause) =>
            new Error("ChecksGithubLive: check-run create failed", { cause }),
        });
      }).pipe(Effect.orDie),

    progress: ({ repo, checkRunId, output, detailsUrl }) =>
      Effect.gen(function* () {
        // Same sentinel handling as `update`: a degraded create has no real
        // check-run to PATCH.
        if (checkRunId === NOOP_CHECK_RUN_ID) {
          yield* Effect.logInfo(
            "checks.progress skipped — create returned the no-op sentinel id",
          );
          return;
        }
        const accessToken = yield* token();
        yield* Effect.tryPromise({
          try: () =>
            progressCheckRun({
              token: accessToken,
              repo,
              checkRunId,
              output,
              detailsUrl,
            }),
          catch: (cause) =>
            new Error("ChecksGithubLive: check-run progress update failed", {
              cause,
            }),
        });
      }).pipe(Effect.orDie),

    update: ({ repo, checkRunId, conclusion, output, detailsUrl }) =>
      Effect.gen(function* () {
        // A no-op create (degraded earlier in the same execution) yields the
        // sentinel id — there is no real check-run to PATCH, so skip cleanly.
        if (checkRunId === NOOP_CHECK_RUN_ID) {
          yield* Effect.logInfo(
            "checks.update skipped — create returned the no-op sentinel id",
          );
          return;
        }
        const accessToken = yield* token();
        yield* Effect.tryPromise({
          try: () =>
            updateCheckRun({
              token: accessToken,
              repo,
              checkRunId,
              conclusion,
              output,
              detailsUrl,
            }),
          catch: (cause) =>
            new Error("ChecksGithubLive: check-run update failed", { cause }),
        });
      }).pipe(Effect.orDie),
  };

  return Layer.succeed(Checks, service);
};
