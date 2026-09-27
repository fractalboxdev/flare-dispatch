// FlareDispatch Dispatcher — the GitLab review's map-reduce step wiring.
//
// The review used to be ONE durable step: a large MR's whole fan-out lived or
// died in a single 25-minute attempt. It now runs as separate durable steps:
//
//   review-prepare      fetch + filter the diff, plan the chunks (no model call)
//   review-chunk-<n>    one per chunk — its own retry and timeout, checkpointed,
//                       so a finished chunk never re-runs on a replay
//   review-reduce       merge, verify, verdict, note
//
// A chunk step that exhausts its retries does not fail the review: it becomes
// a failed chunk, and the reduce step lists its files as "Not reviewed".
//
// No `cloudflare:workers` import — the Workflow passes its `step.do` in, the
// tests pass a fake, and the offline replay passes a plain runner.

import type { Effect } from "effect";
import type { Config, ModelGateway, Scm } from "@fractalboxdev/flare-dispatch-core";
import {
  mrReviewChunk,
  mrReviewPrepare,
  mrReviewReduce,
  type ChunkResult,
  type MrComputeResult,
  type MrReviewInput,
} from "@fractalboxdev/flare-dispatch-runs/mr-review";

export type ReviewStepKind = "prepare" | "chunk" | "reduce";

/** Run `cb` as the named durable step (the Workflow picks the config by `kind`). */
export type ReviewStepRunner = <T>(name: string, kind: ReviewStepKind, cb: () => Promise<T>) => Promise<T>;

/** Run an Effect over the review's Layers (config + model + scm). */
export type ReviewEffectRunner = <A>(eff: Effect.Effect<A, never, Config | ModelGateway | Scm>) => Promise<A>;

export const runChunkedReview = async (opts: {
  readonly input: MrReviewInput;
  readonly step: ReviewStepRunner;
  readonly run: ReviewEffectRunner;
  /** Attempts a chunk step makes before it counts as failed — for the reason text. */
  readonly chunkAttempts?: number;
}): Promise<{ readonly result: MrComputeResult; readonly steps: number }> => {
  const { input, step, run } = opts;
  const prep = await step("review-prepare", "prepare", () => run(mrReviewPrepare(input)));
  if (prep.kind === "done") return { result: prep.result, steps: 1 };

  const results: ChunkResult[] = [];
  const width = Math.max(1, prep.concurrency);
  for (let i = 0; i < prep.chunks.length; i += width) {
    const batch = prep.chunks.slice(i, i + width);
    results.push(
      ...(await Promise.all(
        batch.map(async (chunk): Promise<ChunkResult> => {
          try {
            return await step(`review-chunk-${chunk.id}`, "chunk", () => run(mrReviewChunk(prep.ctx, chunk)));
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            const attempts = opts.chunkAttempts !== undefined ? ` after ${opts.chunkAttempts} attempt(s)` : "";
            console.error(`[gitlab-review] chunk ${chunk.id} step failed${attempts}: ${message}`);
            return {
              id: chunk.id,
              paths: chunk.paths,
              status: "failed",
              models: [],
              fallbacks: 0,
              findings: [],
              // The step's own usage is lost with the step — not a true zero.
              usage: { inputTokens: 0, outputTokens: 0, calls: 0, unknown: true, byModel: {} },
              error: `chunk step failed${attempts}: ${message}`,
              failedAgents: [],
              rateLimited: false,
            };
          }
        }),
      )),
    );
  }

  const result = await step("review-reduce", "reduce", () => run(mrReviewReduce(input, prep, results)));
  return { result, steps: 2 + prep.chunks.length };
};
