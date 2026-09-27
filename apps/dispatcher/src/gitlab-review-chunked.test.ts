// The GitLab review's map-reduce step wiring: prepare → one durable step per
// chunk → reduce. Driven with a fake step runner (no `cloudflare:workers`).

import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { ModelGateway, type ModelCompletionRequest } from "@fractalboxdev/flare-dispatch-core";
import { makeConfigFake, makeScmFake } from "@fractalboxdev/flare-dispatch-core/testing";
import type { MrReviewInput } from "@fractalboxdev/flare-dispatch-runs/mr-review";
import { runChunkedReview, type ReviewStepKind } from "./gitlab-review-chunked";

const input: MrReviewInput = {
  projectId: "42",
  iid: 7,
  headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  baseSha: "base456",
  projectWebUrl: "https://gitlab.com/group/proj",
};

const fileDiff = (path: string, lines: number): string =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,${lines} +1,${lines} @@`,
    ...Array.from({ length: lines }, (_, i) => `+const v${i} = "${"y".repeat(60)}";`)].join("\n") + "\n";

const layerFor = (diff: string) =>
  Layer.mergeAll(
    makeScmFake({ diff }).layer,
    Layer.succeed(ModelGateway, {
      complete: (_req: ModelCompletionRequest) => Effect.succeed({ toolCalls: [], text: '{"findings":[]}' }),
    }),
    makeConfigFake({
      "pr-review.workers-ai.model": "@cf/test/primary",
      "pr-review.workers-ai.mode": "json",
      "pr-review.naive.enabled": "false",
      "pr-review.verify.enabled": "false",
      "pr-review.chunk.maxChars": "10000",
      "pr-review.chunk.concurrency": "2",
    }),
  );

const recorder = (failChunk?: string) => {
  const steps: Array<{ name: string; kind: ReviewStepKind }> = [];
  const step = async <T,>(name: string, kind: ReviewStepKind, cb: () => Promise<T>): Promise<T> => {
    steps.push({ name, kind });
    if (name === failChunk) throw new Error("step timed out");
    return cb();
  };
  return { steps, step };
};

describe("runChunkedReview", () => {
  it("runs prepare, one step per chunk, then reduce — and counts the steps", async () => {
    const diff = fileDiff("src/a.ts", 120) + fileDiff("src/b.ts", 120) + fileDiff("src/c.ts", 120);
    const { steps, step } = recorder();
    const out = await runChunkedReview({ input, step, run: (eff) => Effect.runPromise(eff.pipe(Effect.provide(layerFor(diff)))) });
    expect(steps[0]).toEqual({ name: "review-prepare", kind: "prepare" });
    expect(steps.at(-1)).toEqual({ name: "review-reduce", kind: "reduce" });
    const chunkSteps = steps.filter((s) => s.kind === "chunk").map((s) => s.name);
    expect(chunkSteps.length).toBeGreaterThanOrEqual(3);
    expect(new Set(chunkSteps).size).toBe(chunkSteps.length);
    expect(out.steps).toBe(steps.length);
    expect(out.result.status).toBe("success");
  });

  it("a chunk step that exhausts its retries becomes a failed chunk — the review still completes", async () => {
    const diff = fileDiff("src/a.ts", 120) + fileDiff("src/b.ts", 120);
    const { step } = recorder("review-chunk-1");
    const out = await runChunkedReview({ input, step, chunkAttempts: 2, run: (eff) => Effect.runPromise(eff.pipe(Effect.provide(layerFor(diff)))) });
    expect(out.result.status).toBe("success");
    expect(out.result.output?.verdict).not.toBe("approve");
    expect(out.result.noteBody).toMatch(/Not reviewed[\s\S]*chunk step failed after 2 attempt\(s\): step timed out/);
  });

  it("an empty diff finishes in the prepare step (no chunk, no reduce)", async () => {
    const { steps, step } = recorder();
    const out = await runChunkedReview({ input, step, run: (eff) => Effect.runPromise(eff.pipe(Effect.provide(layerFor("")))) });
    expect(steps.map((s) => s.name)).toEqual(["review-prepare"]);
    expect(out.result.noteBody).toContain("Nothing to review");
  });
});
