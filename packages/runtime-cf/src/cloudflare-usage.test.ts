// Pure tests for the GraphQL usage normalization (no Workers runtime).

import { describe, expect, it } from "vitest";
import { graphqlUrl, normalizeUsage, type RawUsageResponse } from "./cloudflare-live";

describe("graphqlUrl", () => {
  it("appends /graphql to the API base", () => {
    expect(graphqlUrl("https://api.cloudflare.com/client/v4")).toBe(
      "https://api.cloudflare.com/client/v4/graphql",
    );
  });
});

describe("normalizeUsage", () => {
  const resp: RawUsageResponse = {
    data: {
      viewer: {
        accounts: [
          {
            workersInvocationsAdaptive: [
              { sum: { requests: 1828, errors: 46 }, dimensions: { scriptName: "flare-dispatch-v0" } },
              { sum: { requests: 12, errors: 0 }, dimensions: { scriptName: "otp-demo" } },
              // No scriptName → dropped.
              { sum: { requests: 5, errors: 0 }, dimensions: {} },
            ],
            aiGatewayRequestsAdaptiveGroups: [
              // Same model split across cacheStatus → aggregated, hits counted.
              { count: 200, dimensions: { model: "glm-4.7-flash", provider: "deepseek", cacheStatus: "miss" } },
              { count: 10, dimensions: { model: "glm-4.7-flash", provider: "deepseek", cacheStatus: "hit" } },
              { count: 30, dimensions: { model: "@cf/llama", provider: "workers-ai", cacheStatus: "miss" } },
            ],
          },
        ],
      },
    },
  };

  it("maps workers by script, sorted by requests, dropping nameless rows", () => {
    const u = normalizeUsage(resp, 168);
    expect(u.windowHours).toBe(168);
    expect(u.workers.map((w) => w.script)).toEqual(["flare-dispatch-v0", "otp-demo"]);
    expect(u.workers[0]).toEqual({ script: "flare-dispatch-v0", requests: 1828, errors: 46 });
  });

  it("aggregates AI by (provider,model) and counts cache hits", () => {
    const u = normalizeUsage(resp, 168);
    expect(u.ai).toHaveLength(2);
    const glm = u.ai.find((a) => a.model === "glm-4.7-flash")!;
    expect(glm).toEqual({ model: "glm-4.7-flash", provider: "deepseek", requests: 210, cached: 10 });
    // Sorted by requests descending → glm (210) before @cf/llama (30).
    expect(u.ai[0]!.model).toBe("glm-4.7-flash");
  });

  it("returns an empty snapshot when the account node is missing", () => {
    expect(normalizeUsage({ data: { viewer: { accounts: [] } } }, 24)).toEqual({
      windowHours: 24,
      workers: [],
      ai: [],
    });
    expect(normalizeUsage({}, 24)).toEqual({ windowHours: 24, workers: [], ai: [] });
  });
});
