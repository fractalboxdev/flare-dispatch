// `playwright-e2e` — sharded Playwright suite with browser pool.
//
// One container per shard via the `sharded` primitive, each invoking
// `playwright test --shard=i/N`. The suite's Playwright config dials CF Browser
// Rendering for the actual browser; `requiresBrowser: true` declares the
// binding. Per-shard HTML reports upload to R2 as 30-day artifacts.
//
// Contract per specs/02-runs.md § 3. Rides on `sharded` + `workspace({ install
// : true })` so the body is "run Playwright for this shard, upload its report."
//
// The recipe at recipes/browser-tests/playwright-e2e.run.ts re-exports this
// run for self-contained copy-paste.

import { Effect, Schema } from "effect";
import {
  artifact,
  config,
  defineRun,
  sandbox,
  step,
  type WebhookPayload,
} from "@fractalboxdev/flare-dispatch-core";
import { sharded, workspace } from "@fractalboxdev/flare-dispatch-core/primitives";

const PlaywrightE2EInput = Schema.Struct({
  repo: Schema.String,
  sha: Schema.String,
  // Optional so the run is wirable BOTH ways. Action mode (the recipe `ci.yml`)
  // passes it explicitly — typically the PR's preview-deploy URL the workflow
  // already knows. Webhook mode omits it: a `pull_request` payload carries no
  // deploy URL, so the run resolves it from `playwright-e2e.base-url` in
  // CONFIG_KV (see the run body) and dies loudly if neither is set.
  baseURL: Schema.optional(Schema.String),
  shards: Schema.optional(Schema.Number),
  project: Schema.optional(Schema.String),
});

type PlaywrightE2EInputT = Schema.Schema.Type<typeof PlaywrightE2EInput>;

/** True when the PR carries `name` as a label — the opt-in gate for Webhook mode. */
const hasLabel = (payload: WebhookPayload, name: string): boolean =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
  payload.pull_request?.labels?.some((l: { name: string }) => l.name === name) ??
  false;

const PlaywrightE2EOutput = Schema.Struct({
  shards: Schema.Number,
  passed: Schema.Number,
  failed: Schema.Number,
  shardResults: Schema.Array(
    Schema.Struct({
      index: Schema.Number,
      exitCode: Schema.Number,
      reportUri: Schema.String,
    }),
  ),
});

const SHARDS_DEFAULT = 4;

export const playwrightE2E = defineRun({
  name: "playwright-e2e",
  version: "1.0.0",
  image:
    "registry.cloudflare.com/fractalbox/flare-dispatch-playwright:latest",
  inputs: PlaywrightE2EInput,
  outputs: PlaywrightE2EOutput,
  limits: { maxDurationSec: 2400, maxConcurrency: 8, requiresBrowser: true },

  // Webhook-mode trigger — receiver-side equivalent of a GHA `on:` filter, and
  // OPT-IN: it fires only when the PR carries the `request-e2e` label, so
  // installing the App does NOT blanket-run e2e on every push. `inputs` maps
  // {repo, sha} straight from the payload; `baseURL` is intentionally omitted
  // and resolved from `playwright-e2e.base-url` (CONFIG_KV) in the run body —
  // a PR payload has no deploy URL to hand it. The semantic `idempotencyKey`
  // matches Action mode's `{run}:{repo_}:{sha12}`, so a repo that BOTH installs
  // the App and dispatches from CI collapses to one run per head SHA.
  triggers: [
    {
      event: "pull_request",
      actions: ["opened", "synchronize", "ready_for_review", "labeled"],
      gate: ({ payload }) =>
        hasLabel(payload, "request-e2e") &&
        !payload.pull_request.user.login.endsWith("[bot]"),
      idempotencyKey: ({ payload }) =>
        `playwright-e2e:${payload.repository.full_name.replace(/\//g, "_")}:${payload.pull_request.head.sha.slice(0, 12)}`,
      inputs: ({ payload }): PlaywrightE2EInputT => ({
        repo: payload.repository.full_name,
        sha: payload.pull_request.head.sha,
      }),
    },
  ],

  run: (input) =>
    Effect.gen(function* () {
      // Resolve the target URL up front so a misconfigured wiring dies cheaply,
      // before any shard container boots. Action mode passes `baseURL`; Webhook
      // mode leaves it unset and we fall back to CONFIG_KV.
      const baseURL =
        input.baseURL ?? (yield* config.get("playwright-e2e.base-url"));
      if (!baseURL) {
        return yield* Effect.die(
          new Error(
            "playwright-e2e: no baseURL — pass `inputs.baseURL` (Action mode) " +
              "or set `playwright-e2e.base-url` in CONFIG_KV (Webhook mode)",
          ),
        );
      }
      const shards = input.shards ?? SHARDS_DEFAULT;
      const projectArg = input.project ? ["--project", input.project] : [];

      const shardResults = yield* step("run-shards", () =>
        sharded({
          count: shards,
          body: ({ index, total }) =>
            Effect.gen(function* () {
              const { container, dir } = yield* workspace({
                repo: input.repo,
                sha: input.sha,
                install: true,
              });
              const exec = yield* sandbox.exec({
                cwd: dir,
                container,
                env: { BASE_URL: baseURL },
                command: [
                  "pnpm", "exec", "playwright", "test",
                  "--shard", `${index}/${total}`,
                  ...projectArg,
                ],
              });
              const reportUri = yield* artifact.upload({
                name: `playwright-report-${index}`,
                path: `${dir}/playwright-report/`,
                container,
                signedUrlTTL: "30 days",
              });
              return { index, exitCode: exec.exitCode, reportUri };
            }),
        }),
      );

      const failed = shardResults.filter((r) => r.exitCode !== 0).length;
      return {
        shards,
        passed: shards - failed,
        failed,
        shardResults,
      };
    }),
});
