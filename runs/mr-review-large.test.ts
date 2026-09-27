// Large-MR review: map (one model pass per chunk) → reduce (dedupe, verify,
// render) — no silent truncation, a naive-model fallback per failed reviewer,
// and a partial result instead of "could not complete".

import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";
import {
  ModelGateway,
  type ModelCompletionRequest,
  type ModelCompletionResult,
  ModelGatewayError,
} from "@fractalboxdev/flare-dispatch-core";
import { makeConfigFake, makeScmFake } from "@fractalboxdev/flare-dispatch-core/testing";
import {
  mrReviewChunk,
  mrReviewCompute,
  mrReviewPrepare,
  mrReviewReduce,
  type MrReviewInput,
} from "./mr-review";

const input: MrReviewInput = {
  projectId: "42",
  iid: 7,
  headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  baseSha: "base456",
  projectWebUrl: "https://gitlab.com/group/proj",
};

const PRIMARY = "@cf/test/primary";
const NAIVE = "@cf/test/naive";

const config = (extra: Record<string, string> = {}) =>
  makeConfigFake({
    "pr-review.workers-ai.model": PRIMARY,
    "pr-review.workers-ai.mode": "json",
    "pr-review.naive.model": NAIVE,
    "pr-review.naive.enabled": "false",
    "pr-review.verify.enabled": "false",
    ...extra,
  });

const fileDiff = (path: string, lines: number): string =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${lines} +1,${lines} @@`,
    ...Array.from({ length: lines }, (_, i) => `+const v${i} = "${"y".repeat(60)}";`),
  ].join("\n") + "\n";

const findingJson = (path: string, title: string) =>
  JSON.stringify({
    findings: [{ path, startLine: 1, endLine: 1, level: "warning", title, message: `${title} message` }],
  });

/** A gateway that answers by model, reading which file the chunk carries. */
const gateway = (answer: (req: ModelCompletionRequest) => ModelCompletionResult | ModelGatewayError) => {
  const requests: ModelCompletionRequest[] = [];
  const layer = Layer.succeed(ModelGateway, {
    complete: (req: ModelCompletionRequest) =>
      Effect.suspend(() => {
        requests.push(req);
        const r = answer(req);
        return r instanceof ModelGatewayError ? Effect.fail(r) : Effect.succeed(r);
      }),
  });
  return { layer, requests };
};

const pathIn = (req: ModelCompletionRequest): string =>
  /diff --git a\/(\S+)/.exec(req.user)?.[1] ?? "unknown";

describe("mr-review — large MRs", () => {
  it.effect("reviews a diff far past maxDiffChars in several chunks — nothing truncated", () => {
    const diff = fileDiff("src/a.ts", 120) + fileDiff("src/b.ts", 120) + fileDiff("src/c.ts", 120);
    const scm = makeScmFake({ diff });
    const gw = gateway((req) => ({ toolCalls: [], text: findingJson(pathIn(req), `issue in ${pathIn(req)}`) }));
    return Effect.gen(function* () {
      const r = yield* mrReviewCompute(input);
      expect(r.status).toBe("success");
      // One reviewer call per chunk; every file reached a model.
      const seen = new Set(gw.requests.map(pathIn));
      expect(seen).toEqual(new Set(["src/a.ts", "src/b.ts", "src/c.ts"]));
      for (const req of gw.requests) expect(req.user.length).toBeLessThan(12_000);
      expect(r.noteBody).toContain("issue in src/c.ts");
      expect(r.noteBody).not.toContain("Not reviewed");
      // The last line of the last file was sent (no silent cap).
      expect(gw.requests.some((q) => q.user.includes("v119"))).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(scm.layer, gw.layer, config({ "pr-review.workers-ai.maxDiffChars": "20000", "pr-review.chunk.maxChars": "10000" })),
      ),
    );
  });

  it.effect("asks for streaming, a per-call deadline and the configured reasoning effort", () => {
    const scm = makeScmFake({ diff: fileDiff("src/a.ts", 3) });
    const gw = gateway(() => ({ toolCalls: [], text: '{"findings":[]}' }));
    return Effect.gen(function* () {
      yield* mrReviewCompute(input);
      expect(gw.requests[0]!.stream).toBe(true);
      expect(gw.requests[0]!.timeoutMs).toBe(90_000);
      expect(gw.requests[0]!.reasoningEffort).toBe("low");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          scm.layer,
          gw.layer,
          config({ "pr-review.callTimeoutMs": "90000", "pr-review.workers-ai.reasoningEffort": "low" }),
        ),
      ),
    );
  });

  it.effect("an empty answer on the primary model is retried once on the naive model and recorded", () => {
    const scm = makeScmFake({ diff: fileDiff("src/a.ts", 3) });
    const gw = gateway((req) =>
      req.model === PRIMARY ? { toolCalls: [], text: "" } : { toolCalls: [], text: findingJson("src/a.ts", "found by fallback") },
    );
    return Effect.gen(function* () {
      const prep = yield* mrReviewPrepare(input);
      if (prep.kind !== "chunks") throw new Error("expected chunks");
      const chunk = yield* mrReviewChunk(prep.ctx, prep.chunks[0]!);
      expect(chunk.status).toBe("ok");
      expect(chunk.models).toEqual([NAIVE]);
      expect(chunk.fallbacks).toBe(1);
      // The engine makes its own single json repair retry on the primary first.
      expect(gw.requests.map((q) => q.model)).toEqual([PRIMARY, PRIMARY, NAIVE]);
      const r = yield* mrReviewReduce(input, prep, [chunk]);
      expect(r.noteBody).toContain("found by fallback");
      expect(r.noteBody).toContain(NAIVE);
    }).pipe(Effect.provide(Layer.mergeAll(scm.layer, gw.layer, config())));
  });

  it.effect("a timeout on the primary model also falls back; a rate limit does not", () => {
    const scm = makeScmFake({ diff: fileDiff("src/a.ts", 3) });
    const gw = gateway((req) =>
      req.model === PRIMARY
        ? new ModelGatewayError({ model: PRIMARY, reason: "timeout", message: "3046: Request timeout" })
        : { toolCalls: [], text: '{"findings":[]}' },
    );
    const gwRate = gateway(() => new ModelGatewayError({ model: PRIMARY, reason: "rate-limited", message: "429" }));
    return Effect.gen(function* () {
      const prep = yield* mrReviewPrepare(input);
      if (prep.kind !== "chunks") throw new Error("expected chunks");
      const ok = yield* mrReviewChunk(prep.ctx, prep.chunks[0]!).pipe(Effect.provide(gw.layer));
      expect(ok.status).toBe("ok");
      expect(ok.models).toEqual([NAIVE]);
      const limited = yield* mrReviewChunk(prep.ctx, prep.chunks[0]!).pipe(Effect.provide(gwRate.layer));
      expect(limited.status).toBe("failed");
      expect(limited.rateLimited).toBe(true);
      expect(gwRate.requests).toHaveLength(1);
    }).pipe(Effect.provide(Layer.mergeAll(scm.layer, config())));
  });

  it.effect("a failed chunk yields a partial review: findings + 'Not reviewed', and never ✅ Approve", () => {
    const diff = fileDiff("src/a.ts", 120) + fileDiff("src/b.ts", 120);
    const scm = makeScmFake({ diff });
    const gw = gateway((req) =>
      pathIn(req) === "src/b.ts"
        ? new ModelGatewayError({ model: req.model, reason: "timeout", message: "3046: Request timeout" })
        : { toolCalls: [], text: '{"findings":[]}' },
    );
    return Effect.gen(function* () {
      const r = yield* mrReviewCompute(input);
      expect(r.status).toBe("success");
      expect(r.output?.verdict).not.toBe("approve");
      expect(r.noteBody).not.toMatch(/^### AI code review — ✅ Approve/m);
      expect(r.noteBody).not.toContain("could not complete");
      expect(r.noteBody).toMatch(/Not reviewed[\s\S]*src\/b\.ts[\s\S]*3046/);
      expect(r.noteBody).toMatch(/not ✅ Approve/);
    }).pipe(Effect.provide(Layer.mergeAll(scm.layer, gw.layer, config({ "pr-review.chunk.maxChars": "10000" }))));
  });

  it.effect("files past the chunk cap are listed as not reviewed and block ✅ Approve", () => {
    const diff = fileDiff("src/a.ts", 120) + fileDiff("docs/b.md", 120);
    const scm = makeScmFake({ diff });
    const gw = gateway(() => ({ toolCalls: [], text: '{"findings":[]}' }));
    return Effect.gen(function* () {
      const r = yield* mrReviewCompute(input);
      expect(r.output?.verdict).toBe("comment");
      expect(r.noteBody).toMatch(/Not reviewed[\s\S]*docs\/b\.md[\s\S]*chunk cap \(1\)/);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(scm.layer, gw.layer, config({ "pr-review.chunk.maxChars": "10000", "pr-review.chunk.maxChunks": "1" })),
      ),
    );
  });

  it.effect("every chunk failing is a failure with the reason (one alert later, not per chunk)", () => {
    const scm = makeScmFake({ diff: fileDiff("src/a.ts", 3) });
    const gw = gateway((req) => new ModelGatewayError({ model: req.model, reason: "timeout", message: "3046: Request timeout" }));
    return Effect.gen(function* () {
      const r = yield* mrReviewCompute(input);
      expect(r.status).toBe("failure");
      expect(r.reason).toMatch(/3046/);
    }).pipe(Effect.provide(Layer.mergeAll(scm.layer, gw.layer, config())));
  });

  it.effect("the ignored-path notice still renders and ignored files are never 'not reviewed'", () => {
    const diff = fileDiff("src/a.ts", 3) + fileDiff("pnpm-lock.yaml", 3);
    const scm = makeScmFake({ diff });
    const gw = gateway(() => ({ toolCalls: [], text: '{"findings":[]}' }));
    return Effect.gen(function* () {
      const r = yield* mrReviewCompute(input);
      expect(r.output?.verdict).toBe("approve");
      expect(r.noteBody).toContain("1 file(s) ignored");
      expect(r.noteBody).not.toContain("Not reviewed");
    }).pipe(Effect.provide(Layer.mergeAll(scm.layer, gw.layer, config({ "pr-review.ignorePaths": "pnpm-lock.yaml" }))));
  });
});
