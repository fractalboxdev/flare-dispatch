// `vitest-shard` — turnkey sharded Vitest execution.
//
// Fans a Vitest suite across N containers in parallel, one shard each, and
// aggregates exit codes — the Vitest-native specialization of `matrix-fanout`.
// Vitest is the single most common offload candidate (a big suite), and now
// first-party Cloudflare tooling (VoidZero), so it earns a turnkey run.
//
// Two things make this more than `matrix-fanout` with a default command:
//
//   1. It bakes Vitest's own `--shard=<index>/<total>` flag, constructed from
//      the shard body's `{ index, total }`. The caller passes only the base
//      invocation (default `pnpm exec vitest run`); the run appends the shard
//      coordinate. No `SHARD_INDEX`/`SHARD_TOTAL` env plumbing for the caller
//      to wire — Vitest reads `--shard` directly.
//   2. It installs dependencies by default (`install: true`) — Vitest needs
//      `node_modules`, unlike the generic `matrix-fanout` command which may be
//      self-contained. The R2-cached `installCached` keeps the per-shard cold
//      install bounded.
//
// Like `matrix-fanout`: a non-zero shard exit is a NORMAL result (a failing
// test), summed into `passed`/`failed`; only `ExecFailed`/`ExecTimeout`
// propagate. The dispatcher maps `failed > 0` to the parent check-run
// conclusion at the `RunWorkflow` boundary (runs/offload-test.ts header note 1).
//
// NOTE on report merging: each shard runs in its OWN container with no shared
// filesystem, so Vitest's `--merge-reports` (which needs all shards' blob files
// in one place) can't run in the run body — the same architectural limit
// `matrix-fanout` documents. Each shard's log is uploaded individually; a
// caller wanting a unified report appends `--reporter=blob` to `command` and
// merges the per-shard artifacts downstream.
//
// Spec: specs/02-runs.md § 2, specs/03-dsl.md § Primitives § sandbox.

import { Effect, Schema } from "effect";
import { artifact, defineRun, sandbox, step } from "@fractalbox/flare-dispatch-core";
import { sharded, workspace } from "@fractalbox/flare-dispatch-core/primitives";

/** Input contract. */
const VitestShardInput = Schema.Struct({
  repo: Schema.String, // "owner/name"
  sha: Schema.String,
  shards: Schema.Number, // 2..32
  /**
   * The base Vitest invocation; the run appends `--shard=<index>/<total>`.
   * Defaults to `pnpm exec vitest run`. Override for a different package
   * manager / workspace filter (e.g. `pnpm --filter web exec vitest run`).
   */
  command: Schema.optionalWith(Schema.String, {
    default: () => "pnpm exec vitest run",
  }),
  /**
   * Run the R2-cached dependency install before the suite. Defaults ON —
   * Vitest needs `node_modules`. Set false if the image already has deps.
   */
  install: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  image: Schema.optional(Schema.String), // override container image
});

/** Per-shard result row. */
const ShardResult = Schema.Struct({
  index: Schema.Number,
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  logUri: Schema.String, // signed R2 URL to this shard's log
});

/** Output contract — mirrors `matrix-fanout`. */
const VitestShardOutput = Schema.Struct({
  shardResults: Schema.Array(ShardResult),
  passed: Schema.Number,
  failed: Schema.Number,
});

export const vitestShard = defineRun({
  name: "vitest-shard",
  version: "1.0.0",

  inputs: VitestShardInput,
  outputs: VitestShardOutput,

  limits: {
    maxDurationSec: 1800,
    maxConcurrency: 8,
  },

  run: (input) =>
    Effect.gen(function* () {
      // run-shards — fan the Vitest suite across N shards. Each shard acquires
      // its own container, clones, installs deps, and runs Vitest with its own
      // `--shard=<index>/<total>` coordinate appended to the base command.
      const shardResults = yield* step("run-shards", () =>
        sharded({
          count: input.shards,
          body: ({ index, total }) =>
            Effect.gen(function* () {
              const { container, dir } = yield* workspace({
                repo: input.repo,
                sha: input.sha,
                image: input.image,
                install: input.install,
              });
              const exec = yield* sandbox.exec({
                cwd: dir,
                container,
                // Vitest reads `--shard=<index>/<total>` directly; `index` is
                // 1-based (matches Vitest's expectation + the `sharded` body).
                command: `${input.command} --shard=${index}/${total}`,
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

      // Aggregate exit codes — a non-zero shard is a normal failing-test
      // result; the Effect succeeds either way.
      const failed = shardResults.filter((r) => r.exitCode !== 0).length;
      const passed = shardResults.length - failed;
      return { shardResults, passed, failed };
    }),
});
