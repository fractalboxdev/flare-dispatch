// `deploy-smoke` — post-deploy smoke test against a live URL.
//
// Webhook-mode-first run: fires on `deployment_status.success`, probes a list
// of paths, fails the check-run on the deployed SHA if any path is unhealthy.
// Also dispatchable Action-mode for repos that cannot install the App.
//
// Contract per specs/02-runs.md style + recipes/deploy-smoke. Rides on the
// `probeHttp` primitive so the run body is "probe, classify, log."
//
// The recipe at recipes/deploy-smoke/smoke.run.ts re-exports this run so the
// recipe directory stays self-contained for copy-paste.

import { Effect, Schema } from "effect";
import { defineRun, io, step } from "@fractalbox/flare-dispatch-core";
import { probeHttp } from "@fractalbox/flare-dispatch-core/primitives";

const DeploySmokeInput = Schema.Struct({
  repo: Schema.String,
  sha: Schema.String,
  baseURL: Schema.String,
  paths: Schema.Array(Schema.String),
});

const DeploySmokeOutput = Schema.Struct({
  checked: Schema.Number,
  failed: Schema.Number,
});

export const deploySmoke = defineRun({
  name: "deploy-smoke",
  version: "1.0.0",
  inputs: DeploySmokeInput,
  outputs: DeploySmokeOutput,
  limits: { maxDurationSec: 300 },

  // Webhook-mode trigger — receiver-side equivalent of a GHA `on:` filter.
  // See specs/04-gha-integration.md § Webhook mode.
  triggers: [
    {
      event: "deployment_status",
      gate: ({ payload }) =>
        payload.deployment_status?.state === "success" &&
        payload.deployment?.environment === "production" &&
        !!payload.deployment_status?.environment_url,
      idempotencyKey: ({ payload }) =>
        `deploy-smoke:${payload.repository.full_name}:${payload.deployment.id}`,
      inputs: ({ payload }) => ({
        repo: payload.repository.full_name,
        sha: payload.deployment.sha,
        baseURL: payload.deployment_status.environment_url,
        paths: ["/", "/health", "/api/status"],
      }),
    },
  ],

  run: (input) =>
    Effect.gen(function* () {
      const probe = yield* step("probe", () =>
        probeHttp({ baseURL: input.baseURL, paths: input.paths }),
      );

      yield* io.log(
        probe.failed === 0 ? "info" : "error",
        `deploy-smoke: ${probe.checked - probe.failed}/${probe.checked} endpoints healthy`,
      );

      return { checked: probe.checked, failed: probe.failed };
    }),
});
