// Run-level unit tests for `finops-audit` — drive the run against the in-memory
// test runtime with seeded config + cloudflare (usage/deployments) + model fakes.

import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalbox/flare-dispatch-core/testing";
import type { CloudflareUsage, ModelCompletionResult } from "@fractalbox/flare-dispatch-core";
import { finopsAudit } from "./finops-audit";

const firedAt = Date.UTC(2026, 5, 22); // 2026-06-22 (a Monday)
const input = { firedAt } as const;

const usage: CloudflareUsage = {
  windowHours: 168,
  workers: [{ script: "flare-dispatch-v0", requests: 1828, errors: 46 }],
  ai: [
    // A hot model with a near-zero cache-hit rate — the headline FinOps lever.
    { model: "glm-4.7-flash", provider: "deepseek", requests: 210, cached: 5 },
    { model: "@cf/meta/llama-3.3-70b", provider: "workers-ai", requests: 30, cached: 0 },
  ],
};

const finopsResponse = (): ModelCompletionResult => ({
  toolCalls: [
    {
      name: "report_finops",
      arguments: {
        summary: "AI inference dominates spend; cache hit rate is ~2%.",
        optimizations: [
          {
            title: "Cap pr-review fan-out",
            area: "workers-ai",
            finding: "glm-4.7-flash: 210 requests, 2% cache hit",
            recommendation: "Set pr-review.agents=single or raise the AI Gateway cache TTL",
            estimatedImpact: "~70% fewer inference requests",
          },
        ],
      },
    },
  ],
  text: "",
});

const config = {
  "finops.report-repo": "owner/name",
  "finops.workers-ai.model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
};

describe("finops-audit", () => {
  it.effect("analyses usage and opens a draft PR with the audit file", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config,
      cloudflare: { usage, now: firedAt },
      modelGateway: { responses: [finopsResponse()] },
    });

    return Effect.gen(function* () {
      const out = yield* finopsAudit.run(input);
      expect(out.workerScripts).toBe(1);
      expect(out.aiModels).toBe(2);
      expect(out.optimizations).toBe(1);
      expect(out.prOpened).toBe(true);

      const calls = handles.github.openDraftPullRequestCalls;
      expect(calls).toHaveLength(1);
      expect(calls[0]!.repo).toBe("owner/name");
      expect(calls[0]!.headBranch).toBe("flare-dispatch/finops-2026-06-22");
      expect(calls[0]!.files[0]!.path).toBe(".flare-dispatch/finops-2026-06-22.md");
      const content = calls[0]!.files[0]!.content;
      expect(content).toContain("Cap pr-review fan-out");
      // The usage numbers reached the model + the report.
      expect(content).toContain("glm-4.7-flash");
      const request = handles.modelGateway.requests[0]!;
      expect(JSON.stringify(request)).toContain("210 requests");
      expect(JSON.stringify(request)).toContain("2% hit");
    }).pipe(Effect.provide(layer));
  });

  it.effect("opens NO PR and skips the model when there is no usage", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config,
      // Default empty usage snapshot.
      modelGateway: { responses: [finopsResponse()] },
    });

    return Effect.gen(function* () {
      const out = yield* finopsAudit.run(input);
      expect(out.workerScripts).toBe(0);
      expect(out.aiModels).toBe(0);
      expect(out.prOpened).toBe(false);
      expect(handles.modelGateway.requests).toHaveLength(0);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("is a no-op when no report-repo is configured", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: {},
      cloudflare: { usage, now: firedAt },
    });
    return Effect.gen(function* () {
      const out = yield* finopsAudit.run(input);
      expect(out.prOpened).toBe(false);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});
