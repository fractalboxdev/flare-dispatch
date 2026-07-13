// `matrix-fanout` — the FlareDispatch V1 sharded-test-execution run.
//
// Executes the SAME command across N shards in parallel — one container per
// shard — and aggregates exit codes. Each shard receives `SHARD_INDEX` /
// `SHARD_TOTAL` in its env so the command can split its own work (the typical
// shape: `pnpm test --shard $SHARD_INDEX/$SHARD_TOTAL`). The run is the
// canonical V1 catalog entry promised by specs/02-runs.md § 2.
//
// Contract — inputs/outputs per specs/02-runs.md § 2. Body shape per
// specs/03-dsl.md § Top-level shape and the test-matrix recipe:
// `run-shards → (per-shard) workspace → exec → upload-log`.
//
// --- Two design decisions, documented inline ---------------------------------
//
// 1. No Coordinator DO / Queue / `createBatch` in the run body.
//    specs/02-runs.md § 2 sketches a parent/child Workflows split — parent
//    spawns N child Workflows via `createBatch`, a Durable Object aggregates
//    results, the parent finalizes. That orchestration is platform plumbing,
//    not run logic: the DO + spawner ride below the `step` boundary, owned by
//    the dispatcher (PR #21 territory). The run itself is just the typed
//    sharded program — one `sharded` primitive over per-shard `workspace +
//    exec + upload-log`. When the platform layer lands, the SAME run Effect
//    can be re-wired underneath without touching this file: the `sharded`
//    primitive is the seam, swappable from inline `Effect.forEach` to a
//    `createBatch` + DO aggregation Layer.
//
// 2. A non-zero shard exit is a NORMAL result, not an Effect failure.
//    `sandbox.exec` returns a non-zero `exitCode` on a failing test (same as
//    `offload-test`); only `ExecFailed` / `ExecTimeout` propagate out of the
//    Effect. The run sums up the per-shard `exitCode`s into `passed` / `failed`
//    counters and SUCCEEDS the Effect either way — a red shard is a real
//    result the caller wants to see, not an exception. The dispatcher
//    translates `failed > 0` into the parent check-run conclusion at the
//    `RunWorkflow` boundary (see runs/offload-test.ts header note 1).
//
// Spec: specs/02-runs.md § 2, specs/03-dsl.md § Primitives § sandbox,
//       recipes/test-matrix/matrix-fanout.run.ts (the recipe form).

import { Effect, Schema } from "effect";
import { artifact, defineRun, sandbox, step } from "@fractalboxdev/flare-dispatch-core";
import { sharded, workspace } from "@fractalboxdev/flare-dispatch-core/primitives";

/** Input contract — specs/02-runs.md § 2. */
const MatrixFanoutInput = Schema.Struct({
  repo: Schema.String, // "owner/name"
  sha: Schema.String,
  command: Schema.String, // receives SHARD_INDEX, SHARD_TOTAL env
  shards: Schema.Number, // 2..32
  image: Schema.optional(Schema.String), // override container image
});

/** Per-shard result row. */
const ShardResult = Schema.Struct({
  index: Schema.Number,
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  logUri: Schema.String, // signed R2 URL to this shard's log
});

/** Output contract — specs/02-runs.md § 2. */
const MatrixFanoutOutput = Schema.Struct({
  shardResults: Schema.Array(ShardResult),
  passed: Schema.Number,
  failed: Schema.Number,
});

export const matrixFanout = defineRun({
  name: "matrix-fanout",
  version: "1.0.0",

  inputs: MatrixFanoutInput,
  outputs: MatrixFanoutOutput,

  limits: {
    // Wall-time ceiling — specs/02-runs.md § 2. Per-shard concurrency cap
    // defaults to 8; the platform layer may raise to 100 per `createBatch`
    // call when PR #21 wires it in.
    maxDurationSec: 1800,
    maxConcurrency: 8,
  },

  run: (input) =>
    Effect.gen(function* () {
      // run-shards — fan the command across N shards. `sharded` hands each
      // body { index, total }; the body acquires its own container, clones,
      // executes the command with SHARD_INDEX / SHARD_TOTAL in env, and
      // uploads its log. All N invocations execute concurrently (capped by
      // `limits.maxConcurrency` once the platform layer respects it).
      const shardResults = yield* step("run-shards", () =>
        sharded({
          count: input.shards,
          body: ({ index, total }) =>
            Effect.gen(function* () {
              const { container, dir } = yield* workspace({
                repo: input.repo,
                sha: input.sha,
                image: input.image,
              });
              const exec = yield* sandbox.exec({
                cwd: dir,
                container,
                env: {
                  SHARD_INDEX: String(index),
                  SHARD_TOTAL: String(total),
                },
                command: input.command,
              });
              const logUri = yield* artifact.upload({
                name: `shard-${index}.log`,
                path: exec.logPath,
                container,
                signedUrlTTL: "30 days",
              });
              return {
                index,
                exitCode: exec.exitCode,
                durationMs: exec.durationMs,
                logUri,
              };
            }),
        }),
      );

      // Aggregate exit codes. `failed` counts shards with non-zero exit; the
      // Effect succeeds either way — see header note 2.
      const failed = shardResults.filter((r) => r.exitCode !== 0).length;
      const passed = shardResults.length - failed;
      return { shardResults, passed, failed };
    }),
});
